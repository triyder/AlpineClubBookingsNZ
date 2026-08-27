# Upstream sync: merge composition growth

The upstream sync merge (thatskiff33/main into this fork's main) lands both
sides' additions in the same files. None of the growth below is new code this
PR writes — each file holds fork lines and upstream lines that were each under
an allowance (or ceiling) on their own branch, and the merged sum exceeds the
ceiling measured against this fork's pre-sync base. Splitting a file inside a
sync merge would diverge it from upstream and make every future sync conflict
in that file, which is strictly worse than declaring the composed length.

file: src/app/api/admin/xero/import-member-contact/route.ts
lines: 353
reason: upstream Xero containment work composed onto the fork base.

file: src/lib/admin-permissions.ts
lines: 795
reason: upstream permission additions composed onto the fork's message-board
admin areas.

file: src/lib/email/booking.ts
lines: 1497
reason: the fork's calendar-link compose plus upstream's club-time email date
routing; matches upstream PR #3108's declared length for the same content.

file: src/lib/setup-readiness.ts
lines: 2194
reason: upstream's environment-safety and club-time readiness sections composed
onto the fork base.

file: src/lib/xero-api-client.ts
lines: 782
reason: upstream Xero sandbox containment composed onto the fork base.

file: src/lib/xero-bulk-contact-sync.ts
lines: 725
reason: upstream Xero contact grouping changes composed onto the fork base.
