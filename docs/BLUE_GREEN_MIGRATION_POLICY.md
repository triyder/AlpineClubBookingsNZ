# Blue/Green Migration Policy

Production deploys run Prisma migrations before the new web color receives traffic while the old color can still be serving requests against the shared Postgres database. Every committed migration must therefore preserve old-code/new-schema compatibility until the previous color has drained.

## Required Sequence

- Expand release: add nullable columns, new tables, new indexes, dual-write/backfill support, or compatibility views without removing the old shape used by the currently live app.
- Runtime release: move all reads and writes to the new shape while still tolerating the old one.
- Contract release: remove old columns, tables, indexes, enum values, token fields, or compatibility code only after the previous deployed runtime no longer depends on them.

Destructive contract migrations must name the previous expand/runtime release in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` and must declare `old_code_compatible=yes`. If that cannot be true, the migration is not valid for normal blue/green deploy and needs a separate maintenance/bootstrap plan.

## Deploy Gate

`scripts/run-production-blue-green-deploy.sh --internal-blue-green-deploy` calls `scripts/validate-blue-green-migrations.sh` before `prisma migrate deploy`. The validator checks pending migration SQL for:

- destructive schema removals, renames, type changes, `SET NOT NULL`, and constraint drops
- operations touching hot tables: `Member`, `Booking`, `Payment`, membership tables, finance token tables, and auth/action-token tables — including index, constraint, and trigger creation/removal (`CREATE`/`DROP TRIGGER`, `CREATE CONSTRAINT TRIGGER`) against those tables
- matching entries in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`

Hot-table migrations require a lock-impact plan in the ledger. Potentially breaking migrations also require `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` and a non-empty `BLUE_GREEN_MIGRATION_OVERRIDE_REASON` at deploy time, after the ledger documents why the active old color remains compatible.

## PR-time coverage gate

The deploy gate only inspects migrations still pending against the target database, so a regex-matching migration committed without a ledger entry stays invisible until a deploy aborts before cutover (that is exactly how a fork upgrading from `v0.9.0` was hard-blocked — see issue #1359). CI's `migration-drift` job therefore runs `scripts/check-migration-safety-coverage.sh` on every pull request. It is read-only and needs no database, and it fails the build when:

- a committed migration at or after the ledger baseline (the earliest migration named in the ledger) matches the hot-table/breaking regexes but has no well-formed `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` entry, or
- a new migration reuses an existing timestamp prefix. Prisma orders migrations by folder name, so a duplicate prefix sorts ambiguously. The historical duplicate prefixes that predate this gate are grandfathered in the script; any new collision fails CI. Always stamp a new migration with a timestamp later than every committed migration.

Add the ledger row (and, for destructive changes, follow the expand/contract sequence above) in the same pull request that adds the migration.

## Historical Migrations

The April 2026 migration history contains single-step destructive changes that predate this policy. Those files are not edited retroactively because Prisma records migration checksums after deployment. If any environment still has one of those migrations pending, do not run it through the normal blue/green path; treat it as a bootstrap or maintenance migration with an explicit operator plan.
