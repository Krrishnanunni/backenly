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

# Which database did we actually connect to?
#
# The launcher checks that the secret ARN names a production resource, but that
# is a check on a pointer. This is the check on the connection: when
# EXPECT_DATABASE is set, the URL's database must be that one or nothing runs.
# It matters most for `baseline`, which writes migration history into whatever
# it reaches, and where reaching the wrong database is not recoverable by
# re-running.
#
# Parsed after the LAST '@' so a password containing '/' cannot shift the
# fields. If there is no path at all the extraction yields host:port, which
# matches nothing and refuses — the failure direction we want.
if [ -n "${EXPECT_DATABASE:-}" ]; then
  [ -n "${DATABASE_URL:-}" ] || { echo "refusing: EXPECT_DATABASE is set but DATABASE_URL is empty"; exit 2; }
  _rest=${DATABASE_URL##*@}
  _path=${_rest#*/}
  _db=${_path%%\?*}
  if [ "$_db" != "$EXPECT_DATABASE" ]; then
    echo "refusing: connected database is \"$_db\", expected \"$EXPECT_DATABASE\""
    exit 2
  fi
  echo "database: $_db (matches EXPECT_DATABASE)"
fi

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
