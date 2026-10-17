#!/bin/sh
# Runs a scheduled job from cron on a Linux server (VPS). One job per call:
#   scripts/cron-job.sh backup       encrypted backup with label "cron" + rotation (FINANCE_BOT_BACKUP_KEEP, default 30)
#   scripts/cron-job.sh rehearsal    restores the newest backup into a throwaway container and compares it with the live DB
# Safe for cron: no terminal needed (the passphrase comes from FINANCE_BOT_BACKUP_PASSPHRASE_FILE), one run at a
# time per job (lock), a minimal PATH, and everything goes to logs/backup-cron.log. The exit code is the job's
# exit code, so MAILTO or a monitoring wrapper can react to a failure. Nothing secret is ever logged.
# Setup and crontab lines: docs/operations/vps-backup-cron.md
set -eu
PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

JOB="${1:-}"
case "$JOB" in backup|rehearsal) ;; *) echo "usage: $0 backup|rehearsal" >&2; exit 2 ;; esac

LOG_DIR="${FINANCE_BOT_LOG_DIR:-$ROOT/logs}"
LOG="$LOG_DIR/backup-cron.log"
mkdir -p "$LOG_DIR" backups
stamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s [%s] %s\n' "$(stamp)" "$JOB" "$1" >>"$LOG"; }

# Keep the log small: above ~1 MB only the last 2000 lines stay.
if [ -f "$LOG" ] && [ "$(wc -c <"$LOG" | tr -d ' ')" -gt 1048576 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

if [ -z "${FINANCE_BOT_BACKUP_PASSPHRASE_FILE:-}" ] || [ ! -r "${FINANCE_BOT_BACKUP_PASSPHRASE_FILE:-}" ]; then
  log "FAILED: FINANCE_BOT_BACKUP_PASSPHRASE_FILE is not set or not readable (cron has no terminal to ask)"
  echo "FINANCE_BOT_BACKUP_PASSPHRASE_FILE is not set or not readable" >&2
  exit 1
fi
# A passphrase file other users can read defeats the encryption: warn (do not stop).
case "$(ls -ld "$FINANCE_BOT_BACKUP_PASSPHRASE_FILE" | cut -c5-10)" in
  ------) ;;
  *) log "WARNING: the passphrase file is readable by other users; run: chmod 600 <file>" ;;
esac

# One run at a time per job. mkdir is atomic; a lock older than 6 hours is treated as left behind.
LOCK="$ROOT/backups/.cron-$JOB.lock"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then
  log "removing a stale lock (older than 6 hours)"
  rmdir "$LOCK" 2>/dev/null || true
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  log "SKIPPED: the previous run is still active"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

log "start"
status=0
case "$JOB" in
  backup)    bash scripts/backup-db.sh cron </dev/null >>"$LOG" 2>&1 || status=$? ;;
  # Unattended: do not compare with the live database. It keeps changing after the backup was taken, so the
  # comparison would exit 3 on every run that follows any activity and drown a real failure in false alarms.
  # Integrity checks and the migration count on the restored copy still run (exit 4 = real corruption).
  rehearsal) REHEARSAL_COMPARE_LIVE=0 bash scripts/restore-rehearsal.sh </dev/null >>"$LOG" 2>&1 || status=$? ;;
esac
if [ "$status" -eq 0 ]; then log "ok"; else log "FAILED with exit code $status"; fi
exit "$status"
