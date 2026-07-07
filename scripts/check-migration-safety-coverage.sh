#!/usr/bin/env bash
#
# PR-time coverage gate for blue/green migration safety (issue #1359 / audit F8).
#
# The deploy-time validator (scripts/validate-blue-green-migrations.sh) only
# inspects migrations that are still PENDING against a target database. A
# regex-matching migration committed without a ledger entry therefore stays
# invisible until a production/fork deploy hits the gate and aborts before
# cutover. This script closes that gap by asserting, at PR time, two things:
#
#   1. Ledger coverage: every committed migration at or after the ledger
#      baseline whose SQL matches the validator's hot-table/breaking regexes
#      carries a well-formed docs/BLUE_GREEN_MIGRATION_SAFETY.tsv entry.
#   2. Timestamp hygiene: no two migrations share a timestamp prefix, so a new
#      migration can never sort ambiguously against an existing one. The
#      historical duplicate prefixes that predate this gate are grandfathered.
#
# It is intentionally read-only and needs no database — it runs as an early
# fail-fast step in CI's migration-drift job.
#
# Overridable via environment (used by the contract tests):
#   MIGRATIONS_DIR             directory of migration folders (default prisma/migrations)
#   MIGRATION_SAFETY_LEDGER    ledger TSV path (default docs/BLUE_GREEN_MIGRATION_SAFETY.tsv)
set -Eeuo pipefail

# Deterministic, locale-independent string comparison for timestamp ordering.
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-${REPO_ROOT}/prisma/migrations}"
MIGRATION_SAFETY_LEDGER="${MIGRATION_SAFETY_LEDGER:-${REPO_ROOT}/docs/BLUE_GREEN_MIGRATION_SAFETY.tsv}"
VALIDATOR="${VALIDATOR:-${REPO_ROOT}/scripts/validate-blue-green-migrations.sh}"

# Timestamp prefixes shared by more than one migration on main before this gate
# existed. New migrations must not reuse a prefix; these are grandfathered so the
# ratchet passes on the current history while blocking any future collision.
GRANDFATHERED_DUPLICATE_PREFIXES=(
  20260408060000
  20260527090000
  20260613090000
  20260626120000
  20260628120000
  20260702100000
  20260704150000
)

failures=0

# ---------------------------------------------------------------------------
# 1. Ledger coverage for every migration at or after the ledger baseline.
# ---------------------------------------------------------------------------
if [ ! -f "$MIGRATION_SAFETY_LEDGER" ]; then
  echo "check-migration-safety-coverage: ledger not found at ${MIGRATION_SAFETY_LEDGER}" >&2
  exit 1
fi

# Baseline = the first data row's migration name. Migrations older than the
# baseline predate the ledger (documented as grandfathered historical
# migrations in docs/BLUE_GREEN_MIGRATION_POLICY.md) and are out of scope.
baseline_migration="$(
  awk -F'\t' '
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    { print $1; exit }
  ' "$MIGRATION_SAFETY_LEDGER"
)"

if [ -z "$baseline_migration" ]; then
  echo "check-migration-safety-coverage: ledger ${MIGRATION_SAFETY_LEDGER} has no data rows" >&2
  exit 1
fi

covered_sql_files=()
while IFS= read -r migration_dir; do
  [ -n "$migration_dir" ] || continue
  migration_name="$(basename "$migration_dir")"
  # Skip anything older than the baseline (string compare is safe: names begin
  # with a zero-padded timestamp and LC_ALL=C makes it a byte comparison).
  if [[ "$migration_name" < "$baseline_migration" ]]; then
    continue
  fi
  sql_file="${migration_dir}/migration.sql"
  [ -f "$sql_file" ] && covered_sql_files+=("$sql_file")
done < <(find "$MIGRATIONS_DIR" -mindepth 1 -maxdepth 1 -type d | sort)

if [ "${#covered_sql_files[@]}" -eq 0 ]; then
  echo "check-migration-safety-coverage: no migrations at or after baseline ${baseline_migration}" >&2
else
  # Run the deploy validator over every in-scope migration. The breaking-SQL
  # gate is a deploy-time authorization concern, not a coverage concern, so we
  # neutralise it here — documented contract migrations legitimately contain
  # breaking SQL. What must hold at PR time is that each matching migration has
  # a well-formed ledger entry, i.e. the validator does not report a missing or
  # malformed entry (its found_failure path).
  coverage_err="$(mktemp)"
  if ! MIGRATION_SAFETY_LEDGER="$MIGRATION_SAFETY_LEDGER" \
       ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 \
       BLUE_GREEN_MIGRATION_OVERRIDE_REASON="PR-time ledger-coverage check (documentation gate, not a deploy)" \
       bash "$VALIDATOR" "${covered_sql_files[@]}" >/dev/null 2>"$coverage_err"; then
    echo "Ledger coverage check FAILED: a migration matches the blue/green safety regexes but has no valid ${MIGRATION_SAFETY_LEDGER} entry." >&2
    echo "Add a ledger row (see docs/BLUE_GREEN_MIGRATION_POLICY.md) before merging." >&2
    grep -E 'missing|must ' "$coverage_err" >&2 || true
    failures=1
  else
    echo "Ledger coverage check passed for ${#covered_sql_files[@]} migration(s) at or after ${baseline_migration}." >&2
  fi
  rm -f "$coverage_err"
fi

# ---------------------------------------------------------------------------
# 2. Timestamp-prefix uniqueness ratchet (grandfathering known duplicates).
# ---------------------------------------------------------------------------
is_grandfathered() {
  local prefix="$1"
  local allowed
  for allowed in "${GRANDFATHERED_DUPLICATE_PREFIXES[@]}"; do
    [ "$prefix" = "$allowed" ] && return 0
  done
  return 1
}

duplicate_prefixes="$(
  for migration_dir in "$MIGRATIONS_DIR"/*/; do
    [ -d "$migration_dir" ] || continue
    name="$(basename "$migration_dir")"
    printf '%s\n' "${name%%_*}"
  done | sort | uniq -d
)"

if [ -n "$duplicate_prefixes" ]; then
  while IFS= read -r prefix; do
    [ -n "$prefix" ] || continue
    if is_grandfathered "$prefix"; then
      continue
    fi
    echo "Timestamp hygiene check FAILED: migration timestamp prefix ${prefix} is used by more than one migration." >&2
    echo "A new migration's timestamp must exceed every committed migration's (see docs/BLUE_GREEN_MIGRATION_POLICY.md)." >&2
    failures=1
  done <<<"$duplicate_prefixes"
fi

if [ "$failures" = "0" ]; then
  echo "Migration safety coverage check passed." >&2
fi

exit "$failures"
