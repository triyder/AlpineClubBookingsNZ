# ADR-002: Use Dedicated Finance Access Permissions

## Status

Accepted

## Context

`AlpineClubBookingsNZ` uses application access roles such as `USER`, `ADMIN`,
`LODGE`, `FINANCE_USER`, and `FINANCE_ADMIN`.

The finance dashboard must be available to selected members and selected admins, without granting broad administrative power to all finance viewers.

## Decision

Add dedicated finance access roles separate from membership types and from broad
admin access.

Current roles:

- `FINANCE_USER`
- `FINANCE_ADMIN`

`FINANCE_USER` grants read-only finance access.

`FINANCE_ADMIN` grants privileged finance actions such as triggering a manual
finance sync or managing finance report mappings.

`ADMIN` and `LODGE` do not grant finance access by themselves. Mixed-role
accounts are allowed where intended: for example, `LODGE` plus `FINANCE_USER`
keeps lodge access and grants finance viewer access. `Member.financeAccessLevel`
is kept synchronized as a rollout compatibility field only.

## Consequences

### Positive

- finance access can be granted to named members without making them admins
- finance management privileges can remain narrow
- existing admin authorization boundaries stay intact
- lodge operator access and finance viewer access can be combined without
  inventing a separate global member role

### Negative

- new authorization helpers and UI affordances are required
- member management UI must expose finance access controls
