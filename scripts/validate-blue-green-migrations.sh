#!/usr/bin/env bash
set -Eeuo pipefail

# Requires GNU sed: unsafe_breaking_lines uses the case-insensitive "I" flag on
# its s/// commands (a GNU extension, the only GNU-only construct here). CI runs
# GNU coreutils; BSD/macOS sed rejects the flag and errors out, so the script
# fails closed there rather than silently misclassifying a migration.

ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS="${ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS:-0}"
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="${BLUE_GREEN_MIGRATION_OVERRIDE_REASON:-}"
MIGRATION_SAFETY_LEDGER="${MIGRATION_SAFETY_LEDGER:-docs/BLUE_GREEN_MIGRATION_SAFETY.tsv}"

HOT_TABLE_SQL_REGEX='(ALTER TABLE|UPDATE|DELETE FROM|TRUNCATE|CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX|DROP INDEX|CREATE[[:space:]]+(CONSTRAINT[[:space:]]+)?TRIGGER|DROP TRIGGER|ADD CONSTRAINT|DROP CONSTRAINT|REFERENCES)[^;]*"(Member|MemberSubscription|MemberApplication|MemberCredit|FamilyGroup|FamilyGroupMember|FamilyGroupJoinRequest|Booking|BookingGuest|BookingModification|Payment|PaymentTransaction|PaymentRefund|RefundRequest|PasswordResetToken|EmailVerificationToken|EmailChangeToken|GuestChoreToken|NominationToken|XeroToken|FinanceXeroToken)"'
BREAKING_SQL_REGEX='(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|DROP CONSTRAINT|ALTER TABLE .* RENAME|RENAME COLUMN|ALTER COLUMN .* TYPE|ALTER COLUMN .* SET NOT NULL)'
DESTRUCTIVE_REMOVAL_SQL_REGEX='(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|ALTER TABLE .* RENAME|RENAME COLUMN)'

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

sql_lines() {
  local file="$1"

  awk '
    /^[[:space:]]*--/ { next }
    /^[[:space:]]*$/ { next }
    { printf "%d:%s\n", NR, $0 }
  ' "$file"
}

# Strip a trailing "-- ..." line comment from each stdin line so a comment can
# never defeat the $-anchored NULL-default check (e.g. "SET DEFAULT NULL; -- reset"
# would otherwise classify as a non-NULL default and wrongly waive). Applied only
# in the default-classification pipeline below, NOT in sql_lines/the breaking grep:
# stripping there would drop a breaking keyword that appears inside a trailing
# comment and loosen breaking detection. Common case only: a "--" starts a comment
# unless an ODD number of single quotes precedes it (i.e. it sits inside a
# single-quoted string literal such as SET DEFAULT '--'). Dollar-quoted bodies and
# doubled '' escapes inside a literal are out of scope; migration DEFAULT clauses
# here never use them. Because it only ever trims a trailing comment, it can only
# remove a comment-only false match from selection, never rewrite a real
# SET/DROP DEFAULT statement into something looser.
strip_trailing_sql_comments() {
  awk -v q="'" '{
    n = length($0)
    inq = 0
    for (i = 1; i <= n; i++) {
      c = substr($0, i, 1)
      if (c == q) { inq = !inq; continue }
      if (!inq && c == "-" && substr($0, i + 1, 1) == "-") {
        $0 = substr($0, 1, i - 1)
        break
      }
    }
    print
  }'
}

# Classify a single (already comment-stripped) ALTER COLUMN default statement as a
# NULL reset — one that leaves the column with no usable default, so an old
# colour's omitted-column INSERT still lands a null and a paired SET NOT NULL would
# abort mid-cutover. Returns 0 for a NULL reset (the pairing is vacuous; the
# NOT NULL stays breaking), 1 for a real non-NULL default that backfills.
#
# A NULL reset is any of:
#   * DROP DEFAULT               — removes the default entirely (gap 1)
#   * SET DEFAULT NULL [::type]  — bare or cast NULL
#   * SET DEFAULT (NULL[::type]) — parenthesised NULL
#   * SET DEFAULT NULLIF('','')  — empty-string same-arg NULLIF evaluates to NULL
#   * SET DEFAULT CAST(NULL AS <type>) — casting NULL to any type stays NULL
#
# This is deliberate enumeration, NOT expression evaluation: only these named
# spellings are recognised. Anything else (a function call, a literal, a compound
# expression) is treated as a real non-NULL default. A same-arg NULLIF with
# non-empty args or a CAST wrapped inside a larger expression (e.g.
# COALESCE(CAST(NULL AS text), 'x')) is intentionally left to classify non-NULL;
# recognising arbitrary NULL-valued expressions is out of scope.
default_is_null_reset() {
  local clean="$1"
  # DROP DEFAULT removes the default entirely -> column resets to NULL.
  if printf '%s\n' "$clean" | grep -Eiq 'DROP DEFAULT[[:space:]]*;?[[:space:]]*$'; then
    return 0
  fi
  # Bare or cast NULL: SET DEFAULT NULL [::type] ;
  if printf '%s\n' "$clean" |
    grep -Eiq 'SET DEFAULT[[:space:]]+NULL[[:space:]]*(::[^;]*)?[[:space:]]*;?[[:space:]]*$'; then
    return 0
  fi
  # Parenthesised NULL: SET DEFAULT (NULL) / (NULL::type) [::type] ;
  if printf '%s\n' "$clean" |
    grep -Eiq 'SET DEFAULT[[:space:]]+\([[:space:]]*NULL[[:space:]]*(::[^)]*)?[[:space:]]*\)[[:space:]]*(::[^;]*)?[[:space:]]*;?[[:space:]]*$'; then
    return 0
  fi
  # Empty-string same-arg NULLIF: NULLIF('','') evaluates to NULL.
  if printf '%s\n' "$clean" |
    grep -Eiq "SET DEFAULT[[:space:]]+NULLIF[[:space:]]*\([[:space:]]*''[[:space:]]*,[[:space:]]*''[[:space:]]*\)[[:space:]]*(::[^;]*)?[[:space:]]*;?[[:space:]]*$"; then
    return 0
  fi
  # CAST(NULL AS <type>): the exact type text is irrelevant, but stay anchored so a
  # CAST(NULL ...) nested inside a larger non-NULL expression does not match.
  if printf '%s\n' "$clean" |
    grep -Eiq 'SET DEFAULT[[:space:]]+CAST[[:space:]]*\([[:space:]]*NULL[[:space:]]+AS[[:space:]]+[^()]+(\([^)]*\))?[[:space:]]*\)[[:space:]]*(::[^;]*)?[[:space:]]*;?[[:space:]]*$'; then
    return 0
  fi
  return 1
}

migration_name_for_file() {
  local file="$1"
  basename "$(dirname "$file")"
}

# Breaking SQL lines that are genuinely unsafe for a blue/green cutover. This is
# every BREAKING_SQL_REGEX match EXCEPT an "ALTER COLUMN ... SET NOT NULL" whose
# same table+column also gets a NON-NULL "SET DEFAULT" in the SAME migration: an
# old colour that omits the column on INSERT receives that default, so no null is
# ever written and the NOT NULL holds throughout the cutover (old-code-compatible,
# no outage). Such a NOT NULL still needs a documented ledger entry, but not the
# ALLOW_BREAKING override.
#
# A "SET DEFAULT NULL" does NOT qualify: it fills nothing, so an old colour's
# omitted-column INSERT still lands a null and the NOT NULL would abort — the
# pairing is vacuous and the NOT NULL stays unsafe. NULL is recognised in every
# enumerated spelling (see default_is_null_reset): bare/cast NULL, parenthesised
# (NULL), empty-string NULLIF('',''), and CAST(NULL AS <type>).
#
# The effective default is the LAST same-column SET DEFAULT *or* DROP DEFAULT
# (last-wins). A trailing DROP DEFAULT ordered after the last SET DEFAULT leaves
# the column with no default at all, so it voids the waiver exactly like a
# SET DEFAULT NULL; a DROP DEFAULT ordered before a later SET DEFAULT does not.
# Table/column extraction is case-insensitive (matching the case-insensitive
# greps), so a lowercase "alter table … set not null" can enter this branch and
# waive when it is genuinely paired; a lowercase vacuous pairing still blocks.
# Trailing "-- comments" are stripped before classification. Drops, renames, type
# changes, and an unmatched SET NOT NULL remain unsafe.
unsafe_breaking_lines() {
  local file="$1" breaking line stmt stmt_sql table col default_lines last_default
  breaking="$(sql_lines "$file" | grep -Ei "$BREAKING_SQL_REGEX" || true)"
  [ -n "$breaking" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # strip the leading "NR:" line-number prefix sql_lines adds
    stmt="${line#*:}"
    if printf '%s' "$stmt" | grep -Eiq 'ALTER COLUMN .* SET NOT NULL'; then
      # Extract the table/column from the SQL only, never a trailing comment: the
      # greedy ".*" in the sed capture would otherwise pull the identifier from an
      # "-- ALTER COLUMN \"other\"" comment on this same line, retargeting the
      # default lookup and waiving an unpaired NOT NULL. The breaking-keyword grep
      # above deliberately stays on the raw line (comment keywords must still be
      # caught). Case-insensitive so lowercase SQL enters the branch; the quoted
      # identifier is captured verbatim (Postgres quoted identifiers are
      # case-sensitive).
      stmt_sql="$(printf '%s\n' "$stmt" | strip_trailing_sql_comments)"
      table="$(printf '%s' "$stmt_sql" | sed -nE 's/.*ALTER TABLE "([^"]+)".*/\1/Ip')"
      col="$(printf '%s' "$stmt_sql" | sed -nE 's/.*ALTER COLUMN "([^"]+)".*/\1/Ip')"
      if [ -n "$table" ] && [ -n "$col" ]; then
        # Collect every same-column SET DEFAULT / DROP DEFAULT in file order,
        # trailing comments stripped first so a comment can neither defeat the
        # NULL check nor inject a phantom candidate line into selection.
        default_lines="$(sql_lines "$file" | strip_trailing_sql_comments |
          grep -Ei "ALTER TABLE \"${table}\" ALTER COLUMN \"${col}\" (SET DEFAULT|DROP DEFAULT)" || true)"
        # Last-wins: judge only the final default statement. Waive the NOT NULL iff
        # that last statement is a real non-NULL SET DEFAULT; a SET DEFAULT NULL (any
        # spelling) or a trailing DROP DEFAULT is a NULL reset that keeps it unsafe.
        if [ -n "$default_lines" ]; then
          last_default="$(printf '%s\n' "$default_lines" | tail -n1)"
          if ! default_is_null_reset "$last_default"; then
            continue
          fi
        fi
      fi
    fi
    printf '%s\n' "$line"
  done <<<"$breaking"
}

ledger_entry_for_migration() {
  local migration_name="$1"

  if [ ! -f "$MIGRATION_SAFETY_LEDGER" ]; then
    return 1
  fi

  awk -F'\t' -v migration_name="$migration_name" '
    /^[[:space:]]*#/ { next }
    NF == 0 { next }
    $1 == migration_name {
      print
      found = 1
      exit
    }
    END { exit found ? 0 : 1 }
  ' "$MIGRATION_SAFETY_LEDGER"
}

ledger_field() {
  local entry="$1"
  local field_number="$2"

  awk -F'\t' -v field_number="$field_number" '{ print $field_number }' <<<"$entry"
}

validate_ledger_entry() {
  local migration_name="$1"
  local requires_hot_table_plan="$2"
  local requires_breaking_ack="$3"
  local requires_contract_split="$4"
  local entry="$5"
  local phase
  local previous_release
  local old_code_compatible
  local lock_impact_plan
  local failed=0

  phase="$(trim_whitespace "$(ledger_field "$entry" 2)")"
  previous_release="$(trim_whitespace "$(ledger_field "$entry" 3)")"
  old_code_compatible="$(trim_whitespace "$(ledger_field "$entry" 4)")"
  lock_impact_plan="$(trim_whitespace "$(ledger_field "$entry" 5)")"

  if [[ ! "$phase" =~ ^(expand|contract|metadata-only)$ ]]; then
    echo "${migration_name}: safety ledger phase must be expand, contract, or metadata-only." >&2
    failed=1
  fi

  if [ "$requires_contract_split" = "1" ] && [ "$phase" != "contract" ]; then
    echo "${migration_name}: destructive schema removals must be recorded as phase=contract." >&2
    failed=1
  fi

  if [ "$requires_contract_split" = "1" ] && { [ -z "$previous_release" ] || [ "$previous_release" = "n/a" ]; }; then
    echo "${migration_name}: destructive contract migrations must name the previous expand release." >&2
    failed=1
  fi

  if [ "$requires_breaking_ack" = "1" ] && [ "$old_code_compatible" != "yes" ]; then
    echo "${migration_name}: breaking migrations must declare old_code_compatible=yes in the safety ledger." >&2
    failed=1
  fi

  if [ "$requires_hot_table_plan" = "1" ] && [ -z "$lock_impact_plan" ]; then
    echo "${migration_name}: hot-table migrations must include a lock impact plan in the safety ledger." >&2
    failed=1
  fi

  return "$failed"
}

found_breaking=0
found_failure=0
pending_count=0

if [ "$ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS" = "1" ] &&
  [ -z "$(trim_whitespace "$BLUE_GREEN_MIGRATION_OVERRIDE_REASON")" ]; then
  echo "BLUE_GREEN_MIGRATION_OVERRIDE_REASON is required when ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1." >&2
  exit 1
fi

for migration_sql in "$@"; do
  [ -n "$migration_sql" ] || continue
  pending_count=$((pending_count + 1))

  if [ ! -f "$migration_sql" ]; then
    echo "Migration SQL file not found: ${migration_sql}" >&2
    found_failure=1
    continue
  fi

  migration_name="$(migration_name_for_file "$migration_sql")"
  hot_table_matches="$(sql_lines "$migration_sql" | grep -Ei "$HOT_TABLE_SQL_REGEX" || true)"
  breaking_matches="$(sql_lines "$migration_sql" | grep -Ei "$BREAKING_SQL_REGEX" || true)"
  destructive_removal_matches="$(sql_lines "$migration_sql" | grep -Ei "$DESTRUCTIVE_REMOVAL_SQL_REGEX" || true)"

  if [ -z "$hot_table_matches" ] && [ -z "$breaking_matches" ]; then
    continue
  fi

  ledger_entry="$(ledger_entry_for_migration "$migration_name" || true)"
  if [ -z "$ledger_entry" ]; then
    echo "${migration_name}: missing ${MIGRATION_SAFETY_LEDGER} entry for blue/green migration safety review." >&2
    found_failure=1
  else
    requires_hot_table_plan=0
    requires_breaking_ack=0
    requires_contract_split=0
    [ -n "$hot_table_matches" ] && requires_hot_table_plan=1
    [ -n "$breaking_matches" ] && requires_breaking_ack=1
    [ -n "$destructive_removal_matches" ] && requires_contract_split=1

    if ! validate_ledger_entry \
      "$migration_name" \
      "$requires_hot_table_plan" \
      "$requires_breaking_ack" \
      "$requires_contract_split" \
      "$ledger_entry"; then
      found_failure=1
    fi
  fi

  if [ -n "$hot_table_matches" ]; then
    printf 'Hot-table migration review required: %s\n' "$migration_sql" >&2
    printf '%s\n\n' "$hot_table_matches" >&2
  fi

  if [ -n "$breaking_matches" ]; then
    unsafe_matches="$(unsafe_breaking_lines "$migration_sql" || true)"
    if [ -n "$unsafe_matches" ]; then
      found_breaking=1
      printf 'Potentially blue/green-incompatible migration detected: %s\n' "$migration_sql" >&2
      printf '%s\n\n' "$unsafe_matches" >&2
    else
      printf 'Reviewed no-outage NOT NULL (SET NOT NULL paired with a same-column SET DEFAULT): %s\n' "$migration_sql" >&2
    fi
  fi
done

if [ "$found_failure" = "1" ]; then
  echo "Pending migrations are missing required blue/green safety documentation." >&2
  exit 1
fi

if [ "$found_breaking" = "1" ] && [ "$ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS" != "1" ]; then
  echo "Pending migrations contain potentially breaking SQL for blue/green rollout." >&2
  echo "Set ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1 and BLUE_GREEN_MIGRATION_OVERRIDE_REASON only after the safety ledger proves old-code compatibility." >&2
  exit 1
fi

if [ "$found_breaking" = "1" ]; then
  echo "WARNING: Allowing reviewed breaking migration SQL because ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS=1." >&2
  echo "WARNING: Override reason: ${BLUE_GREEN_MIGRATION_OVERRIDE_REASON}" >&2
elif [ "$pending_count" -gt 0 ]; then
  echo "Blue/green migration safety check passed for ${pending_count} pending migration(s)." >&2
fi
