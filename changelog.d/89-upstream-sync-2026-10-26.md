- **The fork catches up with two weeks of upstream (triyder/AlpineClubBookingsNZ#89).**
  Fork `main` last shared history with thatskiff33 `main` on 9 October; this
  merge brings in the 2,563 upstream commits since, among them the duplicate-
  capture and superseded-capture guards, the night-valuation rework behind
  every booking edit, the inbound credit-note mirror, the reversal and late-
  capture fixes, the audit-category policy, and the dependency moves to
  Sentry 11, Stripe 23 and Next.js 16.4.2. The fork's own features — the
  Alpine Central Server lane, the whole-lodge payment options, the proxied-
  host deploy settings and the default server address — are kept as they
  are; their measured counts (audit writers, view-only opt-outs, date-only
  importers, owner-census line pins) are re-measured on the merged tree.
  Operators: see the pull request's deployment notes for the migrations and
  settings that arrive with this.
