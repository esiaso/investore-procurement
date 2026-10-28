#!/usr/bin/env bash
# Restore drill: restores a backup (default: the newest in BACKUP_DIR) into a
# scratch database and a scratch attachment directory, then checks that every
# table has the row count recorded at backup time and that every attachment
# object referenced by the database is present. Leaves production untouched.
#
#   BACKUP_DIR=/var/backups/silp VERIFY_DATABASE_URL=postgres://…/silp_restore_check ops/backup/verify-restore.sh
#
# VERIFY_DATABASE_URL must name a database this user may DROP and CREATE (its
# name must contain "restore"). Run it weekly; it exits non-zero on any mismatch.
source "$(dirname "$0")/common.sh"

BACKUP_DIR=${BACKUP_DIR:-./backups}
src=${1:-$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | sort | tail -1)}
[[ -n "$src" ]] || die "no backup found in $BACKUP_DIR"
: "${VERIFY_DATABASE_URL:?VERIFY_DATABASE_URL is required (a scratch database)}"
db=$(sed -E 's#.*/([^/?]+)(\?.*)?$#\1#' <<<"$VERIFY_DATABASE_URL")
[[ "$db" == *restore* ]] || die "VERIFY_DATABASE_URL's database name must contain 'restore' (got $db): it is dropped"
admin_url=$(sed -E "s#/[^/?]+(\?.*)?\$#/postgres\1#" <<<"$VERIFY_DATABASE_URL")

log "drill: $src → $db"
$PSQL "$admin_url" -Xq -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" -c "CREATE DATABASE \"$db\""
scratch=$(mktemp -d); trap 'rm -rf "$scratch"; $PSQL "$admin_url" -Xq -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT

DATABASE_URL=$VERIFY_DATABASE_URL STORAGE_DRIVER=local STORAGE_LOCAL_DIR="$scratch/files" RESTORE_CONFIRM=yes \
  "$(dirname "$0")/restore.sh" "$src"

log "comparing row counts"
row_counts "$VERIFY_DATABASE_URL" > "$scratch/after.tsv"
# Tables written while the dump ran can hold more rows than the counts taken just before it, never fewer.
fail=0
while IFS=$'\t' read -r t before; do
  after=$(awk -F'\t' -v t="$t" '$1 == t { print $2 }' "$scratch/after.tsv")
  if [[ -z "$after" ]]; then echo "  MISSING table $t"; fail=1
  elif (( after < before )); then echo "  $t: $after rows restored, $before at backup time"; fail=1; fi
done < "$src/row-counts.tsv"
tables=$(wc -l < "$src/row-counts.tsv" | tr -d ' ')
rows=$(awk -F'\t' '{ s += $2 } END { print s }' "$scratch/after.tsv")

log "checking attachment objects"
missing=0
while read -r key; do
  [[ -z "$key" ]] && continue
  [[ -f "$scratch/files/$key" ]] || { echo "  missing object $key"; missing=$((missing + 1)); }
done < <($PSQL "$VERIFY_DATABASE_URL" -XAtq -c "SELECT storage_key FROM attachment")
files=$(find "$scratch/files" -type f | wc -l | tr -d ' ')
(( missing == 0 )) || fail=1

if (( fail )); then log "RESTORE DRILL FAILED ($src)"; exit 1; fi
log "restore drill passed: $tables tables, $rows rows, $files attachment files ($src)"
