#!/usr/bin/env bash
# Restores a backup made by backup.sh into a database inside the stack's postgres container.
#
#   infra/scripts/restore.sh <file.dump.gz[.age]> <target-db> [--force] [--identity <age-key-file>]
#
# Monthly restore test (recommended; touches nothing live):
#   infra/scripts/restore.sh infra/backups/<latest> ktrade_restore_test
#   docker compose -f infra/docker-compose.prod.yml exec postgres \
#     psql -U ktrade -d ktrade_restore_test -c 'select count(*) from stocks;'
#   docker compose -f infra/docker-compose.prod.yml exec postgres dropdb -U ktrade ktrade_restore_test
#
# Restoring over the LIVE database (`ktrade`) requires --force; stop the API first:
#   docker compose -f infra/docker-compose.prod.yml stop api web
#   infra/scripts/restore.sh <file> ktrade --force
#   docker compose -f infra/docker-compose.prod.yml start api web
# Encrypted dumps need the age private key (--identity, or AGE_IDENTITY); bring it in only for the restore.
# COMPOSE_PROJECT selects a non-default compose project name.
set -euo pipefail
export MSYS_NO_PATHCONV=1

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ $# -ge 2 ]] || usage
FILE="$1"
DB="$2"
shift 2
FORCE=0
IDENTITY="${AGE_IDENTITY:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    --identity) IDENTITY="${2:?--identity needs a file}"; shift ;;
    *) usage ;;
  esac
  shift
done

[[ -f "$FILE" ]] || { echo "no such file: $FILE" >&2; exit 2; }
[[ "$DB" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "target db must match [a-z_][a-z0-9_]*" >&2; exit 2; }
if [[ "$DB" == "ktrade" && "$FORCE" -ne 1 ]]; then
  echo "Refusing to overwrite the live database 'ktrade' without --force (stop api and web first)." >&2
  exit 2
fi

INFRA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose() {
  docker compose -f "$INFRA/docker-compose.prod.yml" ${COMPOSE_PROJECT:+-p "$COMPOSE_PROJECT"} "$@"
}

decode() {
  if [[ "$FILE" == *.age ]]; then
    [[ -n "$IDENTITY" ]] || { echo "encrypted dump: pass --identity <age-key-file>" >&2; exit 2; }
    age -d -i "$IDENTITY" "$FILE" | gunzip
  else
    gunzip -c "$FILE"
  fi
}

if [[ "$DB" != "ktrade" ]]; then
  compose exec -T postgres dropdb -U ktrade --if-exists "$DB"
  compose exec -T postgres createdb -U ktrade "$DB"
fi

# One transaction: either the whole dump lands or nothing changes.
decode | compose exec -T postgres pg_restore -U ktrade -d "$DB" --no-owner --no-privileges \
  --clean --if-exists --single-transaction --exit-on-error

echo "restore ok: $FILE → database '$DB'"
compose exec -T postgres psql -U ktrade -d "$DB" -Atc \
  "select 'migrations applied: ' || count(*) from _prisma_migrations where finished_at is not null"
