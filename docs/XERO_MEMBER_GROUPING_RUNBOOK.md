# Xero member grouping — Tokoroa migration & bulk re-sync runbook

This runbook covers the one-time, owner-coordinated cutover for a club that was
already using age-tier Xero contact groups (Tokoroa's live production tenant)
onto the E8 (#1934) member-grouping model, and the general procedure for the
admin-triggered bulk re-sync.

**Nothing here writes to live Xero automatically.** The bulk re-sync is
admin-triggered and dry-run-first. In the E8 wave the live re-sync is **not**
executed — this document is the procedure the owner follows in a later,
scheduled maintenance window.

## Background

- One club-level mode setting — `None`, `Membership Type`, or
  `Membership Type + Age` — controls whether members are auto-grouped in Xero.
- One rule table (`XeroContactGroupRule`): `MANAGED` rules are the group the
  sync adds; `ACCEPTED` rules are tolerated and never removed.
- The E8 migration backfills existing age-tier group config into **tier-only
  rules** and sets the mode to `Membership Type + Age` when any age-tier group
  config existed, else `None`. Tier-only rules resolve identically to the
  retired age-only sync, so a correctly-grouped member produces **zero diff**.
- The system **never deletes a Xero contact group** and never removes a member
  from a group that no active rule references.

## Pre-checks (do these first, read-only)

1. **Refresh the Xero group cache.** In `/admin/xero`, run "Refresh Xero
   Groups" so the local `XeroContactGroupMembershipCache` reflects current Xero
   truth. The dry-run recomputes from this cache; a stale cache gives a
   misleading diff. Confirm the cache-staleness indicator shows a recent
   refresh.
2. **Verify the migration produced the expected rules.** On the **Xero member
   grouping** admin surface, confirm:
   - the mode is **Membership Type + Age**;
   - there is one **MANAGED tier-only** rule per age tier that previously had a
     primary Xero group, pointing at the same group;
   - one **ACCEPTED tier-only** rule per previously-accepted group;
   - **no other rule is active.** The migration deactivates every pre-existing
     `XeroContactGroupRule` row (written by the retired membership-types
     editor and never read by the live sync) so nothing but the tier-only
     backfill goes live at deploy. Deactivated legacy rules stay visible on
     the surface and can be re-enabled deliberately via the new UI — but only
     after this dry-run cutover has been reviewed.
3. **Run the dry-run diff.** It must show **≈ zero add/remove** for an install
   whose members were already correctly grouped. Investigate any non-zero diff
   before proceeding — the expected residue is only members who were genuinely
   mis-grouped in Xero before the cutover, plus the **information-only**
   section: members no rule matches (e.g. `NOT_APPLICABLE`
   organisations/schools) still sitting in managed groups. Those are surfaced
   with the group(s) they sit in but are **never written to** by any sync or
   bulk run — clean them up manually in Xero if desired.

## Cutover (scheduled window, owner-run)

4. **Owner review.** The owner reviews the dry-run diff (counts, per-member
   add/remove, the estimated Xero call budget, and the list of members skipped
   because they have no Xero contact). No member without a Xero contact is
   silently omitted.
5. **Schedule a window.** Xero limits are ~60 calls/minute and ~5,000/day; the
   re-sync is chunked, resumable, and backs off on 429s. Size the window from
   the dry-run's call-budget estimate.
6. **Run the bulk re-sync.** Admin-triggered from the grouping surface. It is
   cache-first pre-filtered (only mismatched members are touched), processes in
   chunks, and resumes from a member-id cursor. Per-member failures are ledgered
   (in `XeroSyncOperation`) and non-fatal; a daily-limit halt leaves a resume
   cursor to continue the next day. The job never advances the CONTACT
   delta-sync watermark.
7. **Post-check.** Re-refresh the group cache and re-run the dry-run — it should
   now report an **empty** add/remove diff (the information-only section may
   still list `NOT_APPLICABLE` members you choose to leave parked in managed
   groups). Spot-check a few contacts in Xero.
8. **Optional manual cleanup.** Any Xero group the club no longer wants is
   removed **by the owner directly in Xero** — the system never deletes a Xero
   group. Members left in a now-unreferenced group are not touched by the
   system; remove them in Xero manually if desired.

## Notes & guardrails

- **Mode/rule changes never auto-resync.** Switching the mode, or adding,
  editing, deactivating, or deleting a rule, does not re-group anyone
  immediately. Members re-group on their next trigger (age-tier change,
  current-season membership-type change, cron age-up) or via this bulk action.
- **Deleting a rule does not remove members** already in that group — it only
  shrinks the managed universe. The admin UI states this at the point of
  deletion.
- **`None` mode is a total no-op.** Selecting `None` leaves every existing Xero
  group membership untouched and stops all managed adds/removes, including on
  the membership-cancellation path.
- The legacy `AgeTierSetting.xeroContactGroupId/Name` columns and the
  `AgeTierXeroAcceptedContactGroup` table are retained but no longer read after
  E8; they are dropped in the deferred E13 (#1939) after a release soak.
