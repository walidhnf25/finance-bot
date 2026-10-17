# Shared helpers for the backup / restore scripts. Sourced, not executed.
# Never prints secrets: only the database user and name are read from .env.
set -euo pipefail

CONTAINER="${FINANCE_BOT_DB_CONTAINER:-finance-bot-postgres}"

# env_value KEY DEFAULT -> value from .env (nothing else from the file is ever echoed)
env_value() {
  local key="$1" default="$2" line
  line="$(grep -E "^${key}=" .env 2>/dev/null | tail -n1 || true)"
  if [ -n "$line" ]; then
    line="${line#*=}"
    line="${line%\"}"; line="${line#\"}"
    line="${line%\'}"; line="${line#\'}"
    line="${line%$'\r'}"
    printf '%s' "$line"
  else
    printf '%s' "$default"
  fi
}

DB_USER="$(env_value POSTGRES_USER finance_bot)"
DB_NAME="$(env_value POSTGRES_DB finance_bot)"

require_container_running() {
  if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
    echo "Container '$CONTAINER' is not running. Start it with: npm run db:up" >&2
    exit 1
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# How many checks scripts/sql/integrity-checks.sql defines. Kept HERE, independent of the file, so a truncated or
# emptied checks file cannot lower its own bar (src/ops/integrity-checks.spec.ts fails if the two drift apart).
INTEGRITY_EXPECTED_CHECKS=20

# integrity_rows <container> <user> <db>: runs scripts/sql/integrity-checks.sql and prints its "<check>|<count>"
# rows. It FAILS (status 1, reason on stderr) when psql fails or returns fewer rows than the file defines, so a
# wrong database name, an SQL error or a damaged checks file can never read as "all checks passed".
integrity_rows() {
  local container="$1" user="$2" db="$3" out expected got
  expected="$INTEGRITY_EXPECTED_CHECKS"
  out="$(docker exec -i "$container" psql -U "$user" -d "$db" -At -v ON_ERROR_STOP=1 <scripts/sql/integrity-checks.sql 2>&1)" \
    || { echo "The integrity checks could not run on database '$db' in '$container'." >&2; return 1; }
  got="$(printf '%s\n' "$out" | grep -c '|' || true)"
  if [ "$got" -lt "$expected" ]; then
    echo "The integrity checks returned $got of $expected expected rows; refusing to call that a pass." >&2
    return 1
  fi
  printf '%s\n' "$out"
}

# Row counts and money totals used to prove a restored copy equals the source.
# Deterministic text: one line per table.
fingerprint_sql() {
  cat <<'SQL'
SELECT 'users=' || count(*) FROM users
UNION ALL SELECT 'categories=' || count(*) FROM categories
UNION ALL SELECT 'transactions=' || count(*) || ',sum_minor=' || coalesce(sum(amount_minor),0) || ',live=' || count(*) FILTER (WHERE deleted_at IS NULL) FROM transactions
UNION ALL SELECT 'transfers=' || count(*) || ',sum_minor=' || coalesce(sum(amount_minor),0) FROM transfers
UNION ALL SELECT 'budgets=' || count(*) FROM budgets
UNION ALL SELECT 'conversations=' || count(*) FROM conversations
UNION ALL SELECT 'receipt_drafts=' || count(*) FROM receipt_drafts
ORDER BY 1;
SQL
}

# ---- backup encryption (GnuPG symmetric, AES-256, integrity-protected) -----------------------------
# The passphrase is NEVER on a command line and never written next to a backup. It comes from
#   * FINANCE_BOT_BACKUP_PASSPHRASE_FILE : a file YOU keep outside the repository (first line = passphrase), or
#   * an interactive prompt when run from a terminal.
# Losing the passphrase makes the encrypted backups unrecoverable.
GPG_BIN="${GPG_BIN:-gpg}"
GPG_TIMEOUT="${GPG_TIMEOUT:-300}"
PASSPHRASE=""

have_gpg() { command -v "$GPG_BIN" >/dev/null 2>&1; }

is_encrypted_file() { case "$1" in *.gpg) return 0 ;; *) return 1 ;; esac; }

# prepare_passphrase <confirm 0|1>: sets PASSPHRASE_MODE to "file" or "prompt", or exits with help.
prepare_passphrase() {
  local confirm="${1:-0}" second=""
  if [ -n "${FINANCE_BOT_BACKUP_PASSPHRASE_FILE:-}" ]; then
    [ -r "$FINANCE_BOT_BACKUP_PASSPHRASE_FILE" ] || { echo "FINANCE_BOT_BACKUP_PASSPHRASE_FILE is set but not readable." >&2; exit 1; }
    [ -s "$FINANCE_BOT_BACKUP_PASSPHRASE_FILE" ] || { echo "The passphrase file is empty." >&2; exit 1; }
    case "$(cd "$(dirname "$FINANCE_BOT_BACKUP_PASSPHRASE_FILE")" && pwd)/" in
      "$(pwd)"/*) echo "WARNING: the passphrase file is inside the repository folder. Keep it elsewhere (and never next to the backups)." >&2 ;;
    esac
    PASSPHRASE_MODE=file
    return 0
  fi
  if [ -t 0 ]; then
    read -r -s -p "Backup passphrase: " PASSPHRASE; echo >&2
    [ -n "$PASSPHRASE" ] || { echo "Empty passphrase refused." >&2; exit 1; }
    if [ "$confirm" = "1" ]; then
      read -r -s -p "Repeat passphrase: " second; echo >&2
      [ "$PASSPHRASE" = "$second" ] || { echo "The passphrases differ." >&2; exit 1; }
    fi
    PASSPHRASE_MODE=prompt
    return 0
  fi
  cat >&2 <<MSG
No passphrase source. Either run this from a terminal (you will be prompted), or point
FINANCE_BOT_BACKUP_PASSPHRASE_FILE at a file that holds the passphrase on its first line, kept OUTSIDE this
repository, for example:  export FINANCE_BOT_BACKUP_PASSPHRASE_FILE="\$HOME/.finance-bot-backup-passphrase"
To make an UNENCRYPTED backup anyway (not recommended): FINANCE_BOT_BACKUP_ALLOW_PLAINTEXT=1
MSG
  exit 1
}

# gpg_run <gpg args...>: stdin -> stdout, passphrase on a private file descriptor.
gpg_run() {
  if [ "$PASSPHRASE_MODE" = "file" ]; then
    timeout "$GPG_TIMEOUT" "$GPG_BIN" --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 "$@" 3<"$FINANCE_BOT_BACKUP_PASSPHRASE_FILE"
  else
    timeout "$GPG_TIMEOUT" "$GPG_BIN" --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 3 "$@" 3< <(printf '%s\n' "$PASSPHRASE")
  fi
}
gpg_encrypt() { gpg_run --symmetric --cipher-algo AES256 --s2k-mode 3 --s2k-count 65011712 --compress-algo none; }
gpg_decrypt() { gpg_run --decrypt; }

# dump_stream <file>: the plain pg_dump stream of a backup, decrypting on the fly (never to disk).
dump_stream() {
  if is_encrypted_file "$1"; then gpg_decrypt <"$1"; else cat "$1"; fi
}
