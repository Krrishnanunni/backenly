#!/bin/sh
# The migration runner's entire surface.
#
# Two steady-state commands, plus baselining, which is a one-time action for an
# existing database and is NOT part of a normal deploy. It therefore needs an
# explicit confirmation naming the exact migration, so a routine release can
# never resolve a migration as applied by accident.
set -eu

PRISMA=/app/node_modules/.bin/prisma
SCHEMA=/app/prisma/schema.prisma

case "${1:-}" in
  status)
    exec "$PRISMA" migrate status --schema "$SCHEMA"
    ;;
  deploy)
    exec "$PRISMA" migrate deploy --schema "$SCHEMA"
    ;;
  baseline)
    MIGRATION="${2:-}"
    [ -n "$MIGRATION" ] || { echo "baseline needs a migration id"; exit 2; }
    if [ "${MIGRATE_BASELINE_CONFIRM:-}" != "$MIGRATION" ]; then
      echo "refusing: baselining needs MIGRATE_BASELINE_CONFIRM to name the same migration"
      exit 2
    fi
    exec "$PRISMA" migrate resolve --applied "$MIGRATION" --schema "$SCHEMA"
    ;;
  *)
    echo "usage: status | deploy | baseline <migration-id>"
    exit 2
    ;;
esac
