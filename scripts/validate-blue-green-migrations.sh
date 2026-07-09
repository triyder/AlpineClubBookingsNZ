#!/usr/bin/env bash
set -Eeuo pipefail

# Requires GNU sed: unsafe_breaking_lines and same_arg_nullif use the
# case-insensitive "I" s/// flag (a GNU extension, the only GNU-only construct
# here). CI runs GNU coreutils; BSD/macOS sed rejects the flag and errors out,
# so the script fails closed there rather than silently misclassifying.

ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS="${ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS:-0}"
BLUE_GREEN_MIGRATION_OVERRIDE_REASON="${BLUE_GREEN_MIGRATION_OVERRIDE_REASON:-}"
MIGRATION_SAFETY_LEDGER="${MIGRATION_SAFETY_LEDGER:-docs/BLUE_GREEN_MIGRATION_SAFETY.tsv}"

# Baseline for the session-clock DML gate below (#1656 / #1627): migrations whose
# timestamp-prefixed name sorts at or after this value are checked for
# CURRENT_TIMESTAMP/now() inside INSERT/UPDATE payloads; older migrations predate
# the gate and are exempt so committed history never retro-fails. The value sits
# above every migration on main at introduction time (latest was
# 20260708240000, and 20260708220000 legitimately used now() in an UPDATE). This
# is a hard, non-overridable block, mirroring the ledger-coverage baseline in
# check-migration-safety-coverage.sh (skip anything sorting before the baseline).
SESSION_CLOCK_DML_BASELINE="${SESSION_CLOCK_DML_BASELINE:-20260709000000}"

HOT_TABLE_SQL_REGEX='(ALTER TABLE|UPDATE|DELETE FROM|TRUNCATE|CREATE[[:space:]]+(UNIQUE[[:space:]]+)?INDEX|DROP INDEX|CREATE[[:space:]]+(CONSTRAINT[[:space:]]+)?TRIGGER|DROP TRIGGER|ADD CONSTRAINT|DROP CONSTRAINT|REFERENCES)[^;]*"(Member|MemberSubscription|MemberApplication|MemberCredit|FamilyGroup|FamilyGroupMember|FamilyGroupJoinRequest|Booking|BookingGuest|BookingModification|Payment|PaymentTransaction|PaymentRefund|RefundRequest|PasswordResetToken|EmailVerificationToken|EmailChangeToken|GuestChoreToken|NominationToken|XeroToken|FinanceXeroToken)"'
BREAKING_SQL_REGEX='(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|DROP CONSTRAINT|ALTER TABLE .* RENAME|RENAME COLUMN|ALTER COLUMN .* TYPE|ALTER COLUMN .* SET NOT NULL)'
DESTRUCTIVE_REMOVAL_SQL_REGEX='(^|[^A-Z_])(DROP TABLE|DROP COLUMN|DROP TYPE|ALTER TABLE .* RENAME|RENAME COLUMN)'
# A "SET DEFAULT <value>" whose value is semantically NULL fills nothing, so it
# cannot waive a paired SET NOT NULL (see unsafe_breaking_lines). This matches the
# common Postgres/Prisma NULL-default spellings: a bare NULL, a parenthesised
# (NULL), and CAST(NULL AS <type>) — each with an optional ::cast tail and
# tolerant whitespace/semicolon. Expression forms such as NULLIF(...) are
# deliberately NOT matched (they classify as a non-NULL default): SQL expression
# analysis is out of scope for this gate. A parenthesised NULL whose inner cast
# type itself contains parentheses, e.g. "(NULL::numeric(10,2))", is likewise not
# recognised, but plain "(NULL)" and "CAST(NULL AS varchar(10))" are.
NULL_DEFAULT_VALUE_SQL_REGEX='SET DEFAULT[[:space:]]+(NULL|\([[:space:]]*NULL[[:space:]]*(::[^)]*)?[[:space:]]*\)|CAST[[:space:]]*\([[:space:]]*NULL[[:space:]]+AS[[:space:]]+.+\))[[:space:]]*(::[^;]*)?[[:space:]]*;?[[:space:]]*$'
# NULLIF(x, x) with identical single-quoted literals evaluates to NULL, so it
# fills nothing and cannot waive a paired SET NOT NULL (#1602 gap 3 lists it as
# a common spelling). Implemented as two sed extractions + a bash string compare
# rather than an ERE backreference: backrefs in grep -E are non-POSIX and some
# grep implementations (e.g. ugrep) reject them, which would silently classify
# the default as non-NULL and fail OPEN. Only the SAME-argument single-quoted
# form matches; NULLIF with differing arguments — and every other SQL
# expression — still classifies as a non-NULL default: expression analysis
# stays out of scope for this gate.
same_arg_nullif() {
  local line="$1" first second
  first="$(printf '%s' "$line" |
    sed -nE "s/.*SET DEFAULT[[:space:]]+NULLIF[[:space:]]*\([[:space:]]*('[^']*')[[:space:]]*,.*/\1/pI")"
  [ -n "$first" ] || return 1
  second="$(printf '%s' "$line" |
    sed -nE "s/.*SET DEFAULT[[:space:]]+NULLIF[[:space:]]*\([[:space:]]*'[^']*'[[:space:]]*,[[:space:]]*('[^']*')[[:space:]]*\).*/\1/pI")"
  [ -n "$second" ] && [ "$first" = "$second" ]
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

# Remove a trailing "-- ..." SQL line comment so it cannot defeat the end-anchored
# NULL-default check (e.g. "SET DEFAULT NULL; -- reset"). A "--" inside a single-
# or double-quoted string is preserved: the scan tracks quote parity (including
# doubled "''"/'""' escapes) and only cuts at a "--" seen outside any quote.
# Limitation: dollar-quoted string bodies ($tag$...$tag$) and C-style /* */
# comments are not modelled, so a "--" inside those is treated as a comment.
strip_sql_comment() {
  awk -v sq="'" -v dq='"' '
    {
      in_s = 0; in_d = 0; out = $0
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (c == sq && !in_d) { in_s = !in_s; continue }
        if (c == dq && !in_s) { in_d = !in_d; continue }
        if (!in_s && !in_d && c == "-" && substr($0, i + 1, 1) == "-") {
          out = substr($0, 1, i - 1)
          break
        }
      }
      print out
    }
  ' <<<"$1"
}

sql_lines() {
  local file="$1"

  awk '
    /^[[:space:]]*--/ { next }
    /^[[:space:]]*$/ { next }
    { printf "%d:%s\n", NR, $0 }
  ' "$file"
}

# Reconstruct whole SQL statements from a migration file and emit any INSERT or
# UPDATE statement whose payload references the database session clock
# (CURRENT_TIMESTAMP or now()). Session time written into a naive timestamp
# column renders local wall-clock on a non-UTC database, skewing ordering (the
# #1627 default-lodge inversion); DML must write an explicit UTC value instead.
# A DDL "DEFAULT CURRENT_TIMESTAMP" lives in a CREATE/ALTER statement, never in
# an INSERT/UPDATE, so it is deliberately NOT matched.
#
# Statement-level detection is required: an INSERT's CURRENT_TIMESTAMP commonly
# sits many lines below its INSERT keyword, so a per-line scan cannot tell the
# two apart. The awk splitter tracks single-, double-, and dollar-quote state
# and strips "--" line comments (same quote-parity approach as
# strip_sql_comment), splitting only on a ";" seen outside every quote.
#
# Limitations (documented, consistent with strip_sql_comment): C-style /* */
# comments and a literal 'CURRENT_TIMESTAMP'/'now()' inside a quoted string are
# not modelled; a WITH ... INSERT/UPDATE CTE is not anchored (its leading
# keyword is WITH). Dollar-quoted bodies ($$...$$) are treated as opaque so a
# ";" inside them is not a split point — this deliberately avoids false
# positives from CREATE FUNCTION bodies, but it ALSO means an INSERT/UPDATE
# nested inside a DO-block or function body is NOT surfaced (the enclosing
# statement starts with DO/CREATE, not INSERT/UPDATE). This repo does write some
# data migrations as DO-blocks, so a future DO-block using now()/CURRENT_TIMESTAMP
# in a payload is an uncaught vector; the primary #1627 vector — a top-level
# INSERT ... VALUES (..., CURRENT_TIMESTAMP), like the lodge seed — is caught.
# Full PL/pgSQL body coverage would need a parser and is out of scope for this
# line-oriented gate.
session_clock_dml_violations() {
  local file="$1"

  awk -v sq="'" -v dq='"' '
    function flush() {
      if (stmt ~ /[^[:space:]]/) print stmt
      stmt = ""
    }
    {
      line = $0
      n = length(line)
      i = 1
      while (i <= n) {
        c = substr(line, i, 1)
        two = substr(line, i, 2)
        if (in_dollar) {
          if (two == "$$") { in_dollar = 0; stmt = stmt two; i += 2; continue }
          stmt = stmt c; i++; continue
        }
        if (in_s) {
          stmt = stmt c
          if (c == sq) in_s = 0
          i++; continue
        }
        if (in_d) {
          stmt = stmt c
          if (c == dq) in_d = 0
          i++; continue
        }
        if (two == "$$") { in_dollar = 1; stmt = stmt two; i += 2; continue }
        if (c == sq) { in_s = 1; stmt = stmt c; i++; continue }
        if (c == dq) { in_d = 1; stmt = stmt c; i++; continue }
        if (c == "-" && substr(line, i + 1, 1) == "-") { break }
        if (c == ";") { flush(); i++; continue }
        stmt = stmt c
        i++
      }
      stmt = stmt " "
    }
    END { flush() }
  ' "$file" |
    grep -Ei '^[[:space:]]*(INSERT|UPDATE)([[:space:]]|$)' |
    grep -Ei 'CURRENT_TIMESTAMP|(^|[^A-Za-z_])now[[:space:]]*\(' ||
    true
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
# The waiver only holds when the column's EFFECTIVE final default is a real,
# non-NULL constant. Both SET DEFAULT and DROP DEFAULT for the column are read in
# file order and only the LAST one is judged (last-wins):
#   * a "SET DEFAULT NULL" in any spelling — bare, cast "NULL::text", parenthesised
#     "(NULL)", or "CAST(NULL AS <type>)" — fills nothing; and
#   * a trailing DROP DEFAULT after the last SET DEFAULT clears the default;
# either way an old colour's omitted-column INSERT still lands a null and the
# NOT NULL would abort — the pairing is vacuous and stays unsafe. A trailing
# "-- comment" on that final statement is stripped before the NULL check so it
# cannot hide a NULL default behind the end anchor. Expression defaults such as
# NULLIF(...) count as non-NULL (expression analysis is out of scope). Keyword
# matching is case-insensitive so lowercase DDL follows the same rules; quoted
# identifiers keep their original case. Drops, renames, type changes, and an
# unmatched SET NOT NULL remain unsafe.
unsafe_breaking_lines() {
  local file="$1" breaking line stmt table col default_lines last_default
  breaking="$(sql_lines "$file" | grep -Ei "$BREAKING_SQL_REGEX" || true)"
  [ -n "$breaking" ] || return 0
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    # strip the leading "NR:" line-number prefix sql_lines adds
    stmt="${line#*:}"
    if printf '%s' "$stmt" | grep -Eiq 'ALTER COLUMN .* SET NOT NULL'; then
      # Case-insensitive keyword match (GNU sed s///I) so lowercase DDL reaches
      # the waiver logic instead of always blocking; the captured identifiers keep
      # their original case ("[^"]+" is unaffected by the I modifier) because
      # quoted Postgres identifiers are case-significant.
      #
      # Extract from a comment-stripped copy of the statement: the greedy ".*"
      # prefix would otherwise let a trailing '-- ALTER COLUMN "other"' comment
      # retarget the capture and waive an UNPAIRED NOT NULL (#1602 review
      # finding). The raw $line still flows to the output/keyword paths, so
      # stripping here can only prevent a comment-induced false waive.
      stmt_no_comment="$(strip_sql_comment "$stmt")"
      table="$(printf '%s' "$stmt_no_comment" | sed -nE 's/.*ALTER TABLE "([^"]+)".*/\1/pI')"
      col="$(printf '%s' "$stmt_no_comment" | sed -nE 's/.*ALTER COLUMN "([^"]+)".*/\1/pI')"
      if [ -n "$table" ] && [ -n "$col" ]; then
        # Collect both SET DEFAULT and DROP DEFAULT for this column so the
        # effective final default is judged across both statement kinds.
        default_lines="$(sql_lines "$file" |
          grep -Ei "ALTER TABLE \"${table}\" ALTER COLUMN \"${col}\" (SET|DROP) DEFAULT" || true)"
        # Last-wins: only the FINAL SET/DROP DEFAULT is the effective default, so
        # judge only that last line. It waives the NOT NULL iff it is a SET DEFAULT
        # (not a DROP DEFAULT, which clears the default) whose value is non-NULL. A
        # NULL default in any recognised spelling fills nothing, so the pairing is
        # vacuous and the NOT NULL stays unsafe. A trailing "-- comment" is stripped
        # first so it cannot hide a NULL default behind the end anchor.
        if [ -n "$default_lines" ]; then
          last_default="$(strip_sql_comment "$(printf '%s\n' "$default_lines" | tail -n1)")"
          if printf '%s\n' "$last_default" | grep -Eiq 'SET DEFAULT' &&
            ! printf '%s\n' "$last_default" | grep -Eiq "$NULL_DEFAULT_VALUE_SQL_REGEX" &&
            ! same_arg_nullif "$last_default"; then
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

  # Session-clock DML gate (#1656 / #1627): CURRENT_TIMESTAMP/now() inside an
  # INSERT/UPDATE payload is a hard, non-overridable block for migrations at or
  # after the baseline (older ones predate the gate and are exempt so committed
  # history never retro-fails). Runs before the hot/breaking skip below because
  # a plain INSERT matches neither of those regexes. Non-overridable on purpose:
  # it flows through found_failure (not found_breaking), so the PR-time
  # ledger-coverage gate — which sets ALLOW_BREAKING=1 — still enforces it.
  migration_prefix="${migration_name%%_*}"
  if [[ ! "$migration_prefix" < "$SESSION_CLOCK_DML_BASELINE" ]]; then
    session_clock_matches="$(session_clock_dml_violations "$migration_sql")"
    if [ -n "$session_clock_matches" ]; then
      printf 'Session-clock CURRENT_TIMESTAMP/now() in an INSERT/UPDATE payload (write an explicit UTC value instead): %s\n' "$migration_sql" >&2
      printf '%s\n\n' "$session_clock_matches" >&2
      found_failure=1
    fi
  fi

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
