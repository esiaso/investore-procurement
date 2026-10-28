# Shared by backup.sh, restore.sh and verify-restore.sh. Sourced, not run.
set -euo pipefail
# Backups hold the whole database: readable by the backup user only.
umask 077

die() { echo "error: $*" >&2; exit 1; }
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# Optional .env (same file the API uses); explicit environment wins.
if [[ -n "${ENV_FILE:-}" ]]; then
  [[ -f "$ENV_FILE" ]] || die "ENV_FILE $ENV_FILE not found"
  set -a; # shellcheck disable=SC1090
  source <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE"); set +a
fi

PG_DUMP=${PG_DUMP:-pg_dump}
PG_RESTORE=${PG_RESTORE:-pg_restore}
PSQL=${PSQL:-psql}
STORAGE_DRIVER=${STORAGE_DRIVER:-local}
STORAGE_LOCAL_DIR=${STORAGE_LOCAL_DIR:-./var/attachments}
S3_REGION=${S3_REGION:-us-east-1}

sha() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

# aws CLI against S3 or MinIO, with the API's credentials.
s3() {
  command -v aws >/dev/null || die "the aws CLI is needed for STORAGE_DRIVER=s3"
  AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:?}" AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:?}" AWS_DEFAULT_REGION="$S3_REGION" \
    aws ${S3_ENDPOINT:+--endpoint-url "$S3_ENDPOINT"} s3 "$@"
}

# Exact row count of every table, "table<TAB>count", sorted: the restore must give the same.
row_counts() {
  local url=$1
  $PSQL "$url" -XAtq -v ON_ERROR_STOP=1 -c "
    SELECT string_agg(format('SELECT %L AS t, count(*) AS n FROM %I.%I', table_name, table_schema, table_name), ' UNION ALL ')
      FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'" \
  | $PSQL "$url" -XAtq -v ON_ERROR_STOP=1 -F $'\t' | sort
}

# Optional encryption at rest: BACKUP_PASSPHRASE_FILE holds the passphrase (keep it outside the backup location).
encrypt() { if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]]; then openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$1" -out "$1.enc" && rm -f "$1"; fi; }
decrypt() { # file.enc -> file (in place); plain files are left alone
  local f=$1
  if [[ -f "$f.enc" ]]; then
    [[ -n "${BACKUP_PASSPHRASE_FILE:-}" ]] || die "$f.enc is encrypted: set BACKUP_PASSPHRASE_FILE"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$f.enc" -out "$f"
  fi
  [[ -f "$f" ]] || die "$f not found in the backup"
}

# pg_dump / pg_restore must be the server's major version: a newer client writes
# settings an older server rejects on restore (e.g. transaction_timeout in 17).
check_versions() {
  local url=$1 server tool
  server=$($PSQL "$url" -XAtq -c 'SHOW server_version_num' | cut -c1-2)
  for tool in "$PG_DUMP" "$PG_RESTORE"; do
    local v; v=$($tool --version | grep -oE '[0-9]+' | head -1)
    [[ "$v" == "$server" ]] || die "$tool is PostgreSQL $v but the server is $server: use the same major version (set PG_DUMP / PG_RESTORE, e.g. \"docker exec -i <postgres container> pg_dump\")"
  done
}
