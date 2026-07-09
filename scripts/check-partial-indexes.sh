#!/usr/bin/env bash
#
# Partial-index manifest gate (issue #1664).
#
# The schema carries raw-SQL partial (predicated) unique indexes that Prisma
# cannot express, so they are invisible to schema.prisma AND to db:check-drift
# (prisma migrate diff does not surface them — verified on PR #1661). History
# shows they change silently: Member_email_primary_unique was dropped by
# 20260411170000 with no tooling signal. Several of the surviving indexes back
# money/booking/membership invariants, so CI must notice when one disappears.
#
# This script compares the ACTUAL partial indexes in a migrated database (any
# indexdef containing a WHERE predicate, schema public) against the committed
# manifest prisma/partial-unique-indexes.tsv and requires SET EQUALITY:
#   - a manifest row missing from the database  → an expected index was
#     dropped or renamed by a migration → FAIL
#   - a database row missing from the manifest  → a migration added an
#     undocumented partial index → FAIL until it is added to the manifest
#     (the documentation ratchet, same spirit as the blue/green ledger).
#
# It runs in CI's migration-drift job against the drift database after
# `prisma migrate deploy`, and locally against any throwaway database:
#   DATABASE_URL=postgresql://... bash scripts/check-partial-indexes.sh
#
# indexdef text is pg_get_indexdef() output and is stable within a Postgres
# major version; the manifest is maintained against PostgreSQL 16 (the CI
# service image). Regeneration command is in the manifest header.
#
# Overridable via environment (for tests):
#   PARTIAL_INDEX_MANIFEST   manifest path (default prisma/partial-unique-indexes.tsv)
set -Eeuo pipefail

export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${PARTIAL_INDEX_MANIFEST:-${REPO_ROOT}/prisma/partial-unique-indexes.tsv}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "check-partial-indexes: DATABASE_URL must point at a database with all migrations applied" >&2
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "check-partial-indexes: manifest not found at ${MANIFEST}" >&2
  exit 1
fi

# awk (not grep) so a manifest holding only comments/blanks yields an empty
# result instead of dying on grep's exit 1 under `set -e` — the friendly
# "no data rows" error below must stay reachable. Same pattern as
# check-migration-safety-coverage.sh.
expected="$(awk '/^[[:space:]]*#/ { next } NF == 0 { next } { print }' "$MANIFEST" | sort)"

actual="$(
  psql "$DATABASE_URL" -tA -F"$(printf '\t')" -c \
    "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND indexdef LIKE '% WHERE %' ORDER BY tablename, indexname" \
  | sort
)"

if [ -z "$expected" ]; then
  echo "check-partial-indexes: manifest ${MANIFEST} has no data rows" >&2
  exit 1
fi

missing="$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"
undocumented="$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual"))"

failures=0

if [ -n "$missing" ]; then
  echo "Partial-index check FAILED: expected index(es) missing from the migrated database (dropped or renamed by a migration, or the definition changed):" >&2
  printf '%s\n' "$missing" >&2
  echo "If the change is intentional, update prisma/partial-unique-indexes.tsv in the same PR (regeneration command in its header)." >&2
  failures=1
fi

if [ -n "$undocumented" ]; then
  echo "Partial-index check FAILED: undocumented partial index(es) present in the migrated database:" >&2
  printf '%s\n' "$undocumented" >&2
  echo "Add each to prisma/partial-unique-indexes.tsv in the same PR so the invisible-to-Prisma contract stays recorded." >&2
  failures=1
fi

if [ "$failures" = "0" ]; then
  count="$(printf '%s\n' "$expected" | wc -l | tr -d ' ')"
  echo "Partial-index check passed: ${count} partial index(es) match the manifest." >&2
fi

exit "$failures"
