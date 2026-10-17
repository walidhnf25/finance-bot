#!/usr/bin/env bash
# Logical backup of the finance bot database from the running container, ENCRYPTED by default.
#   npm run db:backup            -> backups/db/finance-bot-<UTC timestamp>.dump.gpg (+ .sha256)
# Read-only against the database. The dump holds personal financial data: it is encrypted (GnuPG,
# AES-256, passphrase never stored beside it) before it reaches its final name, and it stays in the
# git-ignored backups/ folder. Copy it somewhere safe yourself. See docs/security/data-protection.md.
#   FINANCE_BOT_BACKUP_PASSPHRASE_FILE=<file outside the repo>    non-interactive passphrase
#   FINANCE_BOT_BACKUP_ALLOW_PLAINTEXT=1                          explicit opt-out (NOT recommended)
#   FINANCE_BOT_BACKUP_KEEP=30                                    rotation: newest N per label, 0 = never delete
#   FINANCE_BOT_BACKUP_MIN_FREE_MB=100                            refuse to start with less free space, 0 = no check
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib-db.sh
. scripts/lib-db.sh

require_container_running
mkdir -p backups/db
chmod 700 backups backups/db 2>/dev/null || true

# A full disk is the one failure PostgreSQL itself handles badly (it can PANIC and refuse to start), so refuse
# early instead of filling the volume the database may share. FINANCE_BOT_BACKUP_MIN_FREE_MB=0 turns the check off.
min_free_mb="${FINANCE_BOT_BACKUP_MIN_FREE_MB:-100}"
free_kb="$(df -Pk backups/db 2>/dev/null | awk 'NR==2 {print $4}')"
if [ "$min_free_mb" -gt 0 ] && [ -n "$free_kb" ] && [ "$free_kb" -lt $((min_free_mb * 1024)) ]; then
  echo "Only $((free_kb / 1024)) MB free where backups are written (minimum $min_free_mb MB). Free some space first." >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
# Optional label: npm run db:backup -- pre-migrasi  ->  finance-bot-pre-migrasi-<stamp>...
label="$(printf '%s' "${1:-}" | tr -c 'A-Za-z0-9-' '-' | cut -c1-40)"
case "$label" in [0-9]*) label="n${label}" ;; esac   # a label never starts with a digit: keeps rotation pools apart
[ -z "$label" ] || stamp="${label}-${stamp}"
encrypt=1
if [ "${FINANCE_BOT_BACKUP_ALLOW_PLAINTEXT:-0}" = "1" ]; then
  encrypt=0
  echo "WARNING: writing an UNENCRYPTED backup (FINANCE_BOT_BACKUP_ALLOW_PLAINTEXT=1)." >&2
else
  have_gpg || { echo "gpg was not found; install GnuPG (Git for Windows includes it) or set GPG_BIN." >&2; exit 1; }
  prepare_passphrase 1
fi

if [ "$encrypt" = "1" ]; then out="backups/db/finance-bot-${stamp}.dump.gpg"; else out="backups/db/finance-bot-${stamp}.dump"; fi
tmp="${out}.part"
trap 'rm -f "$tmp"' EXIT

dump_cmd() { docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --compress=6 --no-owner --no-privileges; }
if [ "$encrypt" = "1" ]; then
  # pipefail: a failing pg_dump OR a failing gpg aborts the whole backup.
  dump_cmd | gpg_encrypt >"$tmp"
else
  dump_cmd >"$tmp"
fi
[ -s "$tmp" ] || { echo "Backup is empty; refusing to keep it." >&2; exit 1; }

# A backup that cannot be read back is not a backup: decrypt (in memory) and list it.
readback() { if [ "$encrypt" = "1" ]; then gpg_decrypt <"$tmp"; else cat "$tmp"; fi; }
readback | docker exec -i "$CONTAINER" pg_restore --list >/dev/null \
  || { echo "The new backup could not be read back; it was discarded." >&2; exit 1; }

mv "$tmp" "$out"
chmod 600 "$out" 2>/dev/null || true
sha="$(sha256_of "$out")"
printf '%s  %s\n' "$sha" "$(basename "$out")" >"${out}.sha256"
trap - EXIT

echo "Backup written: $out ($(wc -c <"$out" | tr -d ' ') bytes, $([ "$encrypt" = "1" ] && echo 'encrypted: GnuPG AES-256' || echo 'NOT encrypted'))"
echo "sha256: $sha"
echo "Verified: it decrypts and lists as a valid PostgreSQL dump."
echo "Prove it restores with: npm run db:restore-rehearsal"

# Rotation: keep the newest FINANCE_BOT_BACKUP_KEEP backups of the SAME label (default 30; 0 turns it off).
# Labels are separate pools on purpose, so a daily "cron" job never deletes a manual "pre-migrasi" backup.
# It only runs after the new backup was written and verified, and it only touches files this script names.
keep="${FINANCE_BOT_BACKUP_KEEP:-30}"
case "$keep" in ''|*[!0-9]*) echo "FINANCE_BOT_BACKUP_KEEP must be a whole number; rotation skipped." >&2; keep=0 ;; esac
if [ "$keep" -gt 0 ]; then
  if [ "$encrypt" = "1" ]; then ext="dump.gpg"; else ext="dump"; fi
  shopt -s nullglob
  pool=( backups/db/finance-bot-"${label:+$label-}"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z."$ext" )   # exact stamp: pools never overlap
  excess=$(( ${#pool[@]} - keep ))
  if [ "$excess" -gt 0 ]; then
    for old in "${pool[@]:0:excess}"; do
      rm -f -- "$old" "${old}.sha256"
      echo "rotated out (keeping newest $keep ${label:-unlabelled}): $(basename "$old")"
    done
  fi
fi
