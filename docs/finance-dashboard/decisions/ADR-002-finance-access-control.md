# ADR-002: Use Dedicated Finance Access Permissions

## Status

Accepted

## Context

`AlpineClubBookingsNZ` uses coarse app-access roles such as `USER`, `ADMIN`, and `LODGE`.

The finance dashboard must be available to selected members and selected admins, without granting broad administrative power to all finance viewers.

## Decision

Add a dedicated finance access model separate from the existing coarse role enum.

Preferred direction:

- `NONE`
- `VIEWER`
- `MANAGER`

`VIEWER` grants read-only finance access.

`MANAGER` grants privileged finance actions such as triggering a manual finance sync or managing the operational Xero connection from `/admin/xero`.

## Consequences

### Positive

- finance access can be granted to named members without making them admins
- finance management privileges can remain narrow
- existing admin authorization boundaries stay intact

### Negative

- new authorization helpers and UI affordances are required
- member management UI must expose finance access controls
