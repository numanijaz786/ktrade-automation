#!/usr/bin/env bash
# Nightly PostgreSQL backup for the production stack.
#   pg_dump custom format (uncompressed) → gzip → optional age encryption → rotation.
# Output: $BACKUP_DIR/ktrade-YYYYmmddTHHMMSSZ.dump.gz[.age]   (default infra/backups/, gitignored, mode 600)
#
# Settings (environment, or read from infra/.env.prod when unset there):
#   BACKUP_DIR             where dumps go               (default: infra/backups)
#   BACKUP_RETENTION_DAYS  delete dumps older than N days (default: 14)
#   BACKUP_AGE_RECIPIENT   age public key (age1...); when set the dump is encrypted and the
#                          plaintext never touches disk. Keep the matching private key OFF the server.
#   COMPOSE_PROJECT        compose project name (default: the file's own `name:`, ktrade-prod)
#
# Cron (root, 02:30 server time; logs to syslog):
#   30 2 * * * /opt/ktrade/infra/scripts/backup.sh 2>&1 | logger -t ktrade-backup
# Copy the dumps off the server too (rclone / restic / scp to another machine): a backup on the same
# disk as the database is not a backup.
set -euo pipefail
export MSYS_NO_PATHCONV=1

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$INFRA/docker-compose.prod.yml"
ENV_FILE="$INFRA/.env.prod"

# Reads one KEY from .env.prod without sourcing the file (values may contain shell metacharacters).
env_value() {
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r'
}

BACKUP_DIR="${BACKUP_DIR:-$INFRA/backups}"
RETENTION="${BACKUP_RETENTION_DAYS:-$(env_value BACKUP_RETENTION_DAYS)}"
RETENTION="${RETENTION:-14}"
RECIPIENT="${BACKUP_AGE_RECIPIENT:-$(env_value BACKUP_AGE_RECIPIENT)}"
[[ "$RETENTION" =~ ^[0-9]+$ ]] || { echo "BACKUP_RETENTION_DAYS must be a whole number" >&2; exit 2; }

compose() {
  docker compose -f "$COMPOSE_FILE" ${COMPOSE_PROJECT:+-p "$COMPOSE_PROJECT"} "$@"
}

umask 077
mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="ktrade-$STAMP.dump.gz"
if [[ -n "$RECIPIENT" ]]; then
  command -v age >/dev/null || { echo "BACKUP_AGE_RECIPIENT is set but 'age' is not installed" >&2; exit 2; }
  NAME="$NAME.age"
fi
TARGET="$BACKUP_DIR/$NAME"
PARTIAL="$TARGET.partial"
trap 'rm -f "$PARTIAL"' EXIT

# -Z0: let gzip do the compression once. --no-owner/--no-privileges keep the dump portable.
dump() { compose exec -T postgres pg_dump -U ktrade -d ktrade -Fc -Z0 --no-owner --no-privileges; }

if [[ -n "$RECIPIENT" ]]; then
  dump | gzip -6 | age -r "$RECIPIENT" >"$PARTIAL"
else
  dump | gzip -6 >"$PARTIAL"
  gzip -t "$PARTIAL"
fi
[[ -s "$PARTIAL" ]] || { echo "backup is empty" >&2; exit 1; }
mv "$PARTIAL" "$TARGET"
trap - EXIT

# Rotation: only our own files, only older than N days.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ktrade-*.dump.gz*' ! -name '*.partial' -mtime "+$RETENTION" -print -delete \
  | sed 's/^/rotated: /'

echo "backup ok: $TARGET ($(wc -c <"$TARGET" | tr -d ' ') bytes)"
