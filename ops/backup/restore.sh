#!/usr/bin/env bash
# Restores a backup made by backup.sh: checks the checksums, restores the
# database into DATABASE_URL (replacing what is there) and the attachments into
# the configured store.
#
#   DATABASE_URL=postgres://… ops/backup/restore.sh /var/backups/silp/20261028T020000Z
#
# Refuses a target database that already has tables unless RESTORE_CONFIRM=yes.
# RESTORE_ATTACHMENTS=no skips the attachment store. Stop the API and the worker first.
source "$(dirname "$0")/common.sh"

src=${1:?usage: restore.sh <backup directory>}
[[ -f "$src/manifest.txt" && -f "$src/SHA256SUMS" ]] || die "$src is not a complete backup (no manifest / SHA256SUMS)"
: "${DATABASE_URL:?DATABASE_URL is required}"

log "checking $src"
(cd "$src" && sha -c --quiet SHA256SUMS) || die "checksum mismatch: the backup is damaged"

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp "$src"/db.dump* "$src"/attachments.tar.gz* "$work"/
decrypt "$work/db.dump"
decrypt "$work/attachments.tar.gz"

tables=$($PSQL "$DATABASE_URL" -XAtq -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'")
if [[ "$tables" != 0 && "${RESTORE_CONFIRM:-}" != yes ]]; then
  die "the target database has $tables tables; set RESTORE_CONFIRM=yes to replace them"
fi

check_versions "$DATABASE_URL"
log "database ← db.dump"
# Clean slate: drop and recreate the public schema (and its types), then restore.
$PSQL "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'
$PG_RESTORE --no-owner --no-privileges --exit-on-error --dbname="$DATABASE_URL" < "$work/db.dump"

if [[ "${RESTORE_ATTACHMENTS:-yes}" == yes ]]; then
  tar -C "$work" -xzf "$work/attachments.tar.gz"
  mkdir -p "$work/files"
  case "$STORAGE_DRIVER" in
    s3) log "attachments → s3://${S3_BUCKET:?}"; s3 sync --only-show-errors "$work/files" "s3://$S3_BUCKET" ;;
    local) log "attachments → $STORAGE_LOCAL_DIR"; mkdir -p "$STORAGE_LOCAL_DIR"; cp -R "$work/files"/. "$STORAGE_LOCAL_DIR"/ ;;
    *) die "STORAGE_DRIVER must be s3 or local" ;;
  esac
fi
log "restored $(grep ^created= "$src/manifest.txt" | cut -d= -f2) into $(sed -E 's#://[^@]*@#://***@#' <<<"$DATABASE_URL")"
