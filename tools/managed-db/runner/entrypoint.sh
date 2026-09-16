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
  verify)
    # Did the objects a migration DECLARES actually land?
    #
    # `migrate status` reports that a migration ran, which is a statement about
    # the history table, not about the schema. These are the objects
    # themselves, read from the catalog, with the expected set fixed HERE. No
    # SQL crosses the boundary: this takes a migration id and nothing else, so
    # it cannot become a query surface on a production database.
    MIGRATION="${2:-}"
    [ -n "$MIGRATION" ] || { echo "verify needs a migration id"; exit 2; }
    case "$MIGRATION" in
      20260916180000_maintenance_approvals)
        # Not exec'd: the marker below has to be printed AFTER the script
        # succeeds. "Script executed successfully" is prisma's own wording for
        # "the statements ran", and a caller cannot tell from it whether this
        # particular assertion was the thing that ran.
        "$PRISMA" db execute --schema "$SCHEMA" --stdin <<'SQL'
DO $$
DECLARE missing text := '';
BEGIN
  IF to_regclass('public.maintenance_approvals') IS NULL THEN
    missing := missing || ' table:maintenance_approvals';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public'
                    AND indexname='maintenance_approvals_planId_planVersion_key') THEN
    missing := missing || ' index:planId_planVersion_key';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public'
                    AND indexname='maintenance_approvals_projectId_revokedAt_idx') THEN
    missing := missing || ' index:projectId_revokedAt_idx';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='maintenance_approvals_projectId_fkey' AND contype='f') THEN
    missing := missing || ' fk:projectId_fkey';
  END IF;
  IF missing <> '' THEN
    RAISE EXCEPTION 'migration 20260916180000 declared objects that are absent:%', missing;
  END IF;
  RAISE NOTICE 'verified: table, both indexes and the foreign key are present';
END $$;
SQL
        echo "VERIFIED: $MIGRATION declared objects are all present"
        ;;
      *)
        echo "refusing: no verification is defined for \"$MIGRATION\""
        exit 2
        ;;
    esac
    ;;
  *)
    echo "usage: status | deploy | baseline <migration-id> | verify <migration-id>"
    exit 2
    ;;
esac
