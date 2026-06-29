# Access-role membership cleanup migration audit

Use this runbook before promoting the access-role and membership-type cleanup
migrations to staging or production. It rehearses the cleanup on a disposable
local PostgreSQL database with representative legacy data, then prints
operator-readable before/after counts.

The script resets the target database's `public` schema. It refuses to run
unless `DATABASE_URL` points at `localhost`, `127.0.0.1`, or `::1`, and the
database name contains `audit`, `scratch`, `test`, `tmp`, `temp`,
`disposable`, or `rehearsal`.

## Rehearsal command

```bash
docker run --rm --name acb-audit-951 \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=access_role_audit \
  -p 127.0.0.1:55435:5432 \
  -d postgres:16-alpine

docker exec acb-audit-951 pg_isready -U postgres -d access_role_audit

DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55435/access_role_audit \
  npm run db:audit-access-role-cleanup -- --yes

docker stop acb-audit-951
```

## What the audit proves

The representative seed includes legacy `Member.role` values for `MEMBER`,
`ASSOCIATE`, `LIFE`, `ADMIN`, `LODGE`, `SCHOOL`, and `NON_MEMBER`; finance
viewer/manager access; current-season `FULL`, `ASSOCIATE`, `LIFE`, and
`RESERVE` assignments; school and non-member contacts; family-group join rows;
age-tier Xero managed groups; and accepted Xero group aliases.

The audit output must show:

- legacy member categories collapsed to `Member.role = USER`
- `MemberAccessRole` rows backfilled from member roles and finance access
- `SCHOOL`, `NON_MEMBER`, and `FAMILY` built-in membership types present
- `RESERVE` seasonal assignments moved to `ASSOCIATE`
- migrated `RESERVE` assignments marked with source detail
- current-season school/non-member assignments moved off `FULL`
- membership-type age-tier rows seeded
- age-tier Xero managed and accepted group rules backfilled
- family-group join rows preserved without treating `FamilyGroupMember.role`
  as an access role

The representative rehearsal should end with `Result: PASS`. The expected
headline counts are:

```text
Before cleanup Member.role:
  MEMBER: 5
  ASSOCIATE: 1
  LIFE: 1
  ADMIN: 1
  LODGE: 1
  SCHOOL: 2
  NON_MEMBER: 1

After cleanup Member.role:
  USER: 7
  ADMIN: 1
  LODGE: 1
  SCHOOL: 2
  NON_MEMBER: 1

After cleanup MemberAccessRole:
  USER: 7
  ADMIN: 1
  LODGE: 1
  FINANCE_USER: 1
  FINANCE_ADMIN: 1
  ORG: 1
```

## Ambiguous production data

If production has both active `RESERVE` and `ASSOCIATE` seasonal assignments
before the cleanup, the migration preserves assignment rows but cannot preserve
two display labels on the single surviving `ASSOCIATE` built-in. The audit
prints a warning for that case. Review whether any operator-facing wording or
export needs a note that former `RESERVE` rows were merged.
