#!/usr/bin/env bash
# Operational health check for cron / Nagios / any monitor that runs a command:
# prints one line per check and exits 0 (OK), 1 (WARNING) or 2 (CRITICAL).
#
#   DATABASE_URL=postgres://… API_URL=https://procure.example.org ops/monitoring/check.sh
#
# Checks: API /health, background jobs (failures, worker silent), e-mail outbox,
# M-PESA payouts waiting for review or unresolved, QuickBooks postings failing,
# eTIMS / HMIS queues, and the age of the newest backup (BACKUP_DIR, optional).
# Thresholds can be overridden with the variables below. PSQL as in ops/backup.
set -uo pipefail
PSQL=${PSQL:-psql}
: "${DATABASE_URL:?DATABASE_URL is required}"
JOB_SILENT_MINUTES=${JOB_SILENT_MINUTES:-90}
OUTBOX_MAX=${OUTBOX_MAX:-50}
BACKUP_MAX_HOURS=${BACKUP_MAX_HOURS:-26}

worst=0
report() { # level(0/1/2) message
  local tag=(OK WARNING CRITICAL)
  echo "${tag[$1]}: $2"
  if (( $1 > worst )); then worst=$1; fi
  return 0
}
q() { $PSQL "$DATABASE_URL" -XAtq -v ON_ERROR_STOP=1 -c "$1" 2>/dev/null; }

if [[ -n "${API_URL:-}" ]]; then
  if curl -fsS --max-time 10 -o /dev/null 2>/dev/null "${API_URL%/}/api/v1/health"; then report 0 "API health"; else report 2 "API ${API_URL%/}/api/v1/health is not answering 200"; fi
fi

if ! q 'SELECT 1' >/dev/null; then report 2 "database is not reachable"; exit 2; fi
report 0 "database"

n=$(q "SELECT count(*) FROM job_run WHERE status = 'FAILED' AND started_at > now() - interval '24 hours'")
(( n > 0 )) && report 1 "$n background job run(s) failed in 24 h: SELECT name, error FROM job_run WHERE status = 'FAILED' ORDER BY started_at DESC" || report 0 "background jobs"
m=$(q "SELECT COALESCE(EXTRACT(EPOCH FROM now() - max(started_at))::int / 60, 99999) FROM job_run")
(( m > JOB_SILENT_MINUTES )) && report 2 "no background job has run for $m minutes: is the worker up (JOBS_MODE=queue)?" || report 0 "worker active ($m min ago)"

n=$(q "SELECT count(*) FROM email_outbox WHERE status <> 'SENT' AND created_at < now() - interval '15 minutes'")
(( n > OUTBOX_MAX )) && report 1 "$n e-mails unsent for over 15 minutes (SMTP_URL?)" || report 0 "e-mail outbox ($n waiting)"

n=$(q "SELECT count(*) FROM mpesa_payout WHERE status = 'UNKNOWN' AND created_at < now() - interval '1 hour'")
(( n > 0 )) && report 1 "$n M-PESA payout(s) with no result after an hour (Payment vouchers, filter Review)" || report 0 "M-PESA payouts"
n=$(q "SELECT count(*) FROM payment_voucher WHERE status::text = 'REVIEW'")
(( n > 0 )) && report 1 "$n payment voucher(s) waiting for M-PESA review" || report 0 "payment vouchers"

n=$(q "SELECT count(*) FROM accounting_posting WHERE status = 'FAILED'")
(( n > 0 )) && report 1 "$n QuickBooks posting(s) failed (QuickBooks screen: errors)" || report 0 "QuickBooks postings"

n=$(q "SELECT count(*) FROM etims_outbox WHERE status::text NOT IN ('ACCEPTED', 'NOT_REQUIRED') AND created_at < now() - interval '24 hours'")
(( n > 0 )) && report 1 "$n eTIMS submission(s) not accepted after 24 h" || report 0 "eTIMS queue"
n=$(q "SELECT count(*) FROM hmis_message WHERE status::text = 'FAILED'")
(( n > 0 )) && report 1 "$n HMIS message(s) failed" || report 0 "HMIS messages"

if [[ -n "${BACKUP_DIR:-}" ]]; then
  newest=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*Z' | sort | tail -1)
  if [[ -z "$newest" ]]; then report 2 "no backup in $BACKUP_DIR"
  else
    age=$(( ( $(date +%s) - $(stat -c %Y "$newest" 2>/dev/null || stat -f %m "$newest") ) / 3600 ))
    (( age > BACKUP_MAX_HOURS )) && report 2 "newest backup is $age h old ($newest)" || report 0 "backup ($age h old)"
  fi
fi
exit $worst
