#!/usr/bin/env bash
# Backs up the database (pg_dump, custom format) and the attachment store
# (MinIO / S3 bucket or the local directory) into BACKUP_DIR/<UTC timestamp>/,
# with a manifest of checksums and exact row counts, then prunes old backups.
#
#   DATABASE_URL=postgres://… BACKUP_DIR=/var/backups/silp ops/backup/backup.sh
#
# Environment (or ENV_FILE=/path/.env): DATABASE_URL, BACKUP_DIR (./backups),
# BACKUP_RETENTION_DAYS (14), BACKUP_PASSPHRASE_FILE (optional: encrypt),
# STORAGE_DRIVER / STORAGE_LOCAL_DIR / S3_* as for the API,
# PG_DUMP / PSQL (override the binaries, e.g. "docker exec -i silp-postgres-1 pg_dump").
# Exit status is non-zero on any failure, so cron / systemd can alert on it.
source "$(dirname "$0")/common.sh"

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR=${BACKUP_DIR:-./backups}
RETENTION=${BACKUP_RETENTION_DAYS:-14}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
out="$BACKUP_DIR/$stamp"
mkdir -p "$out.partial"
tmp=$(mktemp -d)
ok=0
# A failed run leaves nothing behind (and never a backup that looks complete).
trap 'rm -rf "$tmp"; [[ $ok == 1 ]] || { rm -rf "$out.partial"; log "BACKUP FAILED"; }' EXIT

check_versions "$DATABASE_URL"
log "database → $out/db.dump"
# Exact row counts just before the dump, for the restore drill (which expects at
# least as many rows back; a table pruned in the seconds between can trip it: rerun).
row_counts "$DATABASE_URL" > "$out.partial/row-counts.tsv"
$PG_DUMP --format=custom --compress=6 --no-owner --no-privileges "$DATABASE_URL" > "$out.partial/db.dump"
[[ -s "$out.partial/db.dump" ]] || die "pg_dump wrote nothing"

case "$STORAGE_DRIVER" in
  s3)
    log "attachments: s3://${S3_BUCKET:?} → attachments.tar.gz"
    s3 sync --only-show-errors "s3://$S3_BUCKET" "$tmp/files"
    mkdir -p "$tmp/files"
    tar -C "$tmp" -czf "$out.partial/attachments.tar.gz" files ;;
  local)
    log "attachments: $STORAGE_LOCAL_DIR → attachments.tar.gz"
    mkdir -p "$STORAGE_LOCAL_DIR"
    mkdir "$tmp/files"; cp -R "$STORAGE_LOCAL_DIR"/. "$tmp/files"/
    tar -C "$tmp" -czf "$out.partial/attachments.tar.gz" files ;;
  *) die "STORAGE_DRIVER must be s3 or local" ;;
esac
attachments=$(tar -tzf "$out.partial/attachments.tar.gz" | grep -vc '/$' || true)

encrypt "$out.partial/db.dump"
encrypt "$out.partial/attachments.tar.gz"
{
  echo "created=$stamp"
  echo "database=$(sed -E 's#://[^@]*@#://***@#' <<<"$DATABASE_URL")"
  echo "storage=$STORAGE_DRIVER"
  echo "attachments=$attachments"
  echo "encrypted=$([[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]] && echo yes || echo no)"
} > "$out.partial/manifest.txt"
(cd "$out.partial" && sha db.dump* attachments.tar.gz* row-counts.tsv > SHA256SUMS)
mv "$out.partial" "$out"
ok=1
log "done: $out ($(du -sh "$out" | cut -f1), $attachments attachment files)"

# Retention: keep the last RETENTION days, and always the newest backup.
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' -mtime "+$RETENTION" ! -path "$out" -print -exec rm -rf {} + | sed 's/^/pruned /'
