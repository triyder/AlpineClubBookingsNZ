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

## Session-clock DML gate

The validator separately blocks `CURRENT_TIMESTAMP` / `now()` written into an `INSERT` or `UPDATE` payload (issues #1656 / #1627). Session (database-local) time landing in a naive timestamp column renders local wall-clock on a non-UTC database and skews `createdAt` ordering — the defect that once let a same-day app-created lodge silently become the club default. DML must write an explicit UTC value instead, e.g. `timezone('UTC', statement_timestamp())` or a literal `'2026-01-01T00:00:00Z'`. A column `DEFAULT CURRENT_TIMESTAMP` is DDL, not a payload, and is fine. Statements are reconstructed dollar-quote-aware (arbitrary `$tag$…$tag$` bodies, so semicolons inside a quoted HTML payload do not fragment the statement); an unterminated dollar-quote fails the gate rather than passing unchecked. This gate is a **hard, non-overridable block**: `ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1` does not waive it, and it is enforced at both deploy time and PR time (the coverage gate runs the validator with the breaking override set, so the session-clock block still fires). Migrations whose timestamp prefix sorts before the gate's baseline predate it and are exempt so committed history never retro-fails.

The rare reviewed exception is a name-keyed allowlist, `SESSION_CLOCK_DML_ACKNOWLEDGED` in `scripts/validate-blue-green-migrations.sh`, documented in the same spirit as the grandfathered timestamp prefixes: each entry is an exact migration folder name with a comment justifying why the session clock is harmless there — only for a cosmetic write on a cold table with no `createdAt`-ordering invariant to skew (e.g. `20260717180000_genericise_starter_lodge_copy`, which refreshes `updatedAt` on the cold `PageContent` table). The waiver is scoped to the session-clock gate only, never the destructive/hot-table checks, and prefer fixing the migration SQL to write explicit UTC over adding an entry.

## PR-time coverage gate

The deploy gate only inspects migrations still pending against the target database, so a regex-matching migration committed without a ledger entry stays invisible until a deploy aborts before cutover (that is exactly how a fork upgrading from `v0.9.0` was hard-blocked — see issue #1359). CI's `migration-drift` job therefore runs `scripts/check-migration-safety-coverage.sh` on every pull request. It is read-only and needs no database, and it fails the build when:

- a committed migration at or after the ledger baseline (the earliest migration named in the ledger) matches the hot-table/breaking regexes but has no well-formed `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv` entry, or
- a new migration reuses an existing timestamp prefix. Prisma orders migrations by folder name, so a duplicate prefix sorts ambiguously. The historical duplicate prefixes that predate this gate are grandfathered in the script; any new collision fails CI. Always stamp a new migration with a timestamp later than every committed migration.

Add the ledger row (and, for destructive changes, follow the expand/contract sequence above) in the same pull request that adds the migration.

## Historical Migrations

The April 2026 migration history contains single-step destructive changes that predate this policy. Those files are not edited retroactively because Prisma records migration checksums after deployment. If any environment still has one of those migrations pending, do not run it through the normal blue/green path; treat it as a bootstrap or maintenance migration with an explicit operator plan.
