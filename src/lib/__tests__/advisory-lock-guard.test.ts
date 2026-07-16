import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #182 guard (process follow-up to upstream PR #1911 review finding H1): a
// capacity ADMISSION path must use the per-lodge lock, while global-cohort
// booking lifecycle and settlement/money transitions use the canonical global
// pg_advisory_xact_lock(1). A writer that does both takes global first, then
// per-lodge (#1881). This scan makes a disjoint-key regression a CI failure
// instead of an upstream review comment:
//
// 1. The canonical global lock(1) is kept in a reviewed inventory. A new call
//    site must classify the writer using docs/CONCURRENCY_AND_LOCKING.md: use
//    lock(1) for booking-status/settlement money, the per-lodge helper for
//    capacity, and both in that order when the writer composes them. Update the
//    inventory only with that classification and PR lock-impact evidence.
//
// 2. The per-lodge key is minted ONLY by acquireLodgeCapacityLock:
//    hashtextextended must not appear outside src/lib/capacity.ts, so an
//    ad-hoc reconstruction can never drift from the canonical key.
//
// Domain-keyed advisory locks (hashtext of a namespaced string) are
// unrestricted — they are deliberately distinct keyspaces.

const SRC_DIR = path.join(process.cwd(), "src");

// Frozen per-file inventory of canonical global booking/money lock(1) call
// sites (executeRaw occurrences, not comments). Shrinking a count is always
// fine (delete the entry at zero); growing one needs a writer classification
// and explicit justification in the PR that edits this file.
const GLOBAL_BOOKING_MONEY_LOCK_INVENTORY: Record<string, number> = {
  // #1881: the two capacity-admission branches in confirm-pending-guests
  // deliberately compose global lifecycle lock(1) first with the canonical
  // per-lodge capacity lock. The global lock prevents cancellation/settlement
  // resurrection while the lodge lock serialises the capacity claim.
  "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts": 2,
  "src/app/api/bookings/[id]/waitlist-confirm/route.ts": 1,
  "src/app/api/payments/switch-to-internet-banking/route.ts": 1,
  "src/lib/booking-batch-modification-service.ts": 1,
  // #1881 residual: the fifth site protects the linked provisional-child
  // PENDING -> CANCELLED claim. That path also takes the child's per-lodge lock
  // so it excludes confirm-pending before deciding whether cancellation won.
  "src/lib/booking-cancel.ts": 5,
  "src/lib/booking-date-modification-service.ts": 2,
  "src/lib/booking-guest-removal-service.ts": 1,
  "src/lib/booking-request.ts": 1,
  "src/lib/cron-group-settlement-reaper.ts": 2,
  "src/lib/cron-quote-expiry-reminders.ts": 2,
  "src/lib/group-cancel.ts": 2,
  "src/lib/group-settlement.ts": 6,
  "src/lib/internet-banking-payment-cron.ts": 1,
  "src/lib/payment-reconciliation.ts": 1,
  "src/lib/school-booking-request.ts": 1,
  "src/lib/xero-group-settlement-invoices.ts": 3,
  "src/lib/xero-inbound/invoice-paid-effects.ts": 1,
};

const SCOPED_ADVISORY_LOCK_INVENTORY: Record<string, number> = {
  // #1936: the join-request review and group-create approve transactions take
  // member-lifecycle:{memberId} for the pre-existing member being linked, so
  // FamilyGroupMember writes serialize with the application-approval mapping
  // transaction's in-any-family-group collision guard (a FamilyGroupMember
  // insert does not bump Member.updatedAt, so the preview token alone cannot
  // catch the race). Single-lock holders; composition and counterpart analysis
  // in docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/admin-family-group-requests-service.ts": 2,
  "src/lib/admin-roster-service.ts": 1,
  "src/lib/authoritative-fees.ts": 1,
  "src/lib/booking-member-night-conflicts.ts": 1,
  "src/lib/capacity.ts": 1,
  "src/lib/config-transfer/apply.ts": 1,
  "src/lib/member-credit.ts": 1,
  "src/lib/member-lifecycle-actions.ts": 2,
  "src/lib/member-partner-link.ts": 1,
  "src/lib/membership-subscription-billing.ts": 1,
  // #1936: 2 pre-existing membership-application locks (application id +
  // applicant email) plus the approval-mapping transaction's sorted
  // member-lifecycle:{targetId} loop — the approval composes
  // member-application THEN member-lifecycle; ordering and counterpart
  // analysis in docs/CONCURRENCY_AND_LOCKING.md.
  "src/lib/nomination.ts": 3,
  "src/lib/xero-contacts.ts": 2,
};

const ROW_LOCK_SITE_INVENTORY: Record<string, number> = {
  "src/lib/admin-bed-allocation.ts": 1,
  "src/lib/booking-create-promo.ts": 1,
};

const CAPACITY_LOCK_MINT = "src/lib/capacity.ts";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/** Count non-comment source lines in `source` matching `needle`. */
function countCodeOccurrences(source: string, needle: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    let idx = line.indexOf(needle);
    while (idx !== -1) {
      count += 1;
      idx = line.indexOf(needle, idx + needle.length);
    }
  }
  return count;
}

describe("advisory lock guard (#182 / H1 regression class)", () => {
  const sources = walk(SRC_DIR)
    .map((file) => ({
      rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
      text: fs.readFileSync(file, "utf8"),
    }))
    .filter(({ rel }) => !isTestFile(rel));

  it("keeps canonical global pg_advisory_xact_lock(1) sites inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const count = countCodeOccurrences(text, "pg_advisory_xact_lock(1)");
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
        "New pg_advisory_xact_lock(1) call sites detected. Classify the writer " +
        "using docs/CONCURRENCY_AND_LOCKING.md: global-cohort lifecycle and " +
        "settlement money uses this canonical global key; capacity uses " +
        "acquireLodgeCapacityLock(tx, lodgeId); a writer doing both takes global " +
        "first, then per-lodge. Update this inventory only with PR lock-impact " +
        "evidence."
    ).toEqual(GLOBAL_BOOKING_MONEY_LOCK_INVENTORY);
  });

  it("keeps every scoped advisory-lock family inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const allLocks = countCodeOccurrences(text, "pg_advisory_xact_lock(");
      const globalLocks = countCodeOccurrences(text, "pg_advisory_xact_lock(1)");
      const scopedLocks = allLocks - globalLocks;
      if (scopedLocks > 0) found[rel] = scopedLocks;
    }

    expect(
      found,
      "Scoped advisory-lock sites changed. Reconcile the key, counterpart " +
        "writers, and acquisition order in docs/CONCURRENCY_AND_LOCKING.md, " +
        "then update this inventory with PR compatibility evidence.",
    ).toEqual(SCOPED_ADVISORY_LOCK_INVENTORY);
  });

  it("keeps every SELECT FOR UPDATE protocol inside the reviewed inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const count = countCodeOccurrences(text, "FOR UPDATE");
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
      "Row-lock sites changed. Inventory their counterpart writers and order " +
        "against advisory and row locks in docs/CONCURRENCY_AND_LOCKING.md.",
    ).toEqual(ROW_LOCK_SITE_INVENTORY);
  });

  it("keeps school held-reuse on global -> lodge -> re-read -> guarded claim", () => {
    const school = sources.find(
      ({ rel }) => rel === "src/lib/school-booking-request.ts",
    )?.text;
    expect(school).toBeDefined();

    const approval =
      school?.slice(
        school.indexOf("export async function approveSchoolBookingRequest"),
      ) ?? "";
    const locator = approval.indexOf("const heldLodgeLocator = expectedHeldBookingId");
    const transaction = approval.indexOf("conversion = await prisma.$transaction");
    const conditionalGlobal = approval.indexOf("if (expectedHeldBookingId)");
    const globalLock = approval.indexOf("pg_advisory_xact_lock(1)", conditionalGlobal);
    const heldKey = approval.indexOf("expectedHeldLodgeId!", globalLock);
    const lodgeLock = approval.indexOf("acquireLodgeCapacityLock(tx, bookingLodgeId)");
    const requestReread = approval.indexOf(
      "const lockedRequest = await tx.bookingRequest.findUnique",
    );
    const heldReread = approval.indexOf("held = await tx.booking.findUnique");
    const heldClaim = approval.indexOf("const heldClaim = await tx.booking.updateMany");
    const firstSideEffect = approval.indexOf(
      "const guestCreates = await buildApprovalGuestCreates",
    );

    for (const marker of [
      locator,
      transaction,
      conditionalGlobal,
      globalLock,
      heldKey,
      lodgeLock,
      requestReread,
      heldReread,
      heldClaim,
      firstSideEffect,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(locator).toBeLessThan(transaction);
    expect(transaction).toBeLessThan(conditionalGlobal);
    expect(conditionalGlobal).toBeLessThan(globalLock);
    expect(globalLock).toBeLessThan(heldKey);
    expect(heldKey).toBeLessThan(lodgeLock);
    expect(globalLock).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(requestReread);
    expect(requestReread).toBeLessThan(heldReread);
    expect(heldReread).toBeLessThan(heldClaim);
    expect(heldClaim).toBeLessThan(firstSideEffect);
    expect(approval).toContain("if (heldClaim.count === 0)");
    expect(approval).toContain("request.lodgeId !== held.lodgeId");
    expect(approval).toContain("lodgeId: conversion.lodgeId");
  });

  it("binds generic held conversion to the immutable held-booking lodge", () => {
    const generic = sources.find(
      ({ rel }) => rel === "src/lib/booking-request.ts",
    )?.text;
    expect(generic).toBeDefined();

    const approval =
      generic?.slice(
        generic.indexOf("export async function approveBookingRequest"),
      ) ?? "";
    const locator = approval.indexOf("const heldLodgeLocator = expectedHeldBookingId");
    const transaction = approval.indexOf("conversion = await prisma.$transaction");
    const globalLock = approval.indexOf("pg_advisory_xact_lock(1)", transaction);
    const heldKey = approval.indexOf("expectedHeldLodgeId!", globalLock);
    const lodgeLock = approval.indexOf("acquireLodgeCapacityLock(tx, requestLodgeId)");
    const requestReread = approval.indexOf(
      "const lockedRequest = await tx.bookingRequest.findUnique",
    );
    const heldReread = approval.indexOf("held = await tx.booking.findUnique");
    const guardedConversion = approval.indexOf("const converted = await tx.booking.updateMany");

    for (const marker of [
      locator,
      transaction,
      globalLock,
      heldKey,
      lodgeLock,
      requestReread,
      heldReread,
      guardedConversion,
    ]) {
      expect(marker).toBeGreaterThanOrEqual(0);
    }
    expect(locator).toBeLessThan(transaction);
    expect(globalLock).toBeLessThan(heldKey);
    expect(heldKey).toBeLessThan(lodgeLock);
    expect(lodgeLock).toBeLessThan(requestReread);
    expect(requestReread).toBeLessThan(heldReread);
    expect(heldReread).toBeLessThan(guardedConversion);
    expect(approval).toContain("request.lodgeId !== held.lodgeId");
    expect(approval).toContain("lodgeId: conversion.lodgeId");
  });

  it("mints the per-lodge capacity key only in capacity.ts", () => {
    const offenders = sources
      .filter(({ rel }) => rel !== CAPACITY_LOCK_MINT)
      .filter(({ text }) => countCodeOccurrences(text, "hashtextextended") > 0)
      .map(({ rel }) => rel);

    expect(
      offenders,
      "hashtextextended found outside src/lib/capacity.ts. The per-lodge " +
        "capacity key must only be constructed by acquireLodgeCapacityLock so " +
        "every participant provably shares one key — call the helper instead " +
        "of rebuilding the expression."
    ).toEqual([]);
  });
});
