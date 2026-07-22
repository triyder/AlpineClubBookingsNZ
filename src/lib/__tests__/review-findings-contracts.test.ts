import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { spawnSync } from "child_process";
import { describe, expect, it } from "vitest";

function readRepoFile(relativePath: string) {
  // Test helper: reads a fixed repo file under process.cwd(); relativePath is test-controlled, not user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

// #1881 — the lock/key assertions below scan raw source with indexOf/toContain.
// The literal `pg_advisory_xact_lock(1)` also appears in CODE COMMENTS (e.g.
// booking-cancel.ts, cron-quote-expiry-reminders.ts), so a regression that
// deleted the executable `$executeRaw...pg_advisory_xact_lock(1)` line but left
// a comment mentioning it would still pass — the exact laxity class that let the
// original lock-drift regression through. Strip line + block comments (outside
// string/template literals) BEFORE those assertions so only EXECUTABLE lock text
// counts. The executable lock lives inside a template literal
// (`$executeRaw\`SELECT pg_advisory_xact_lock(1)\``), so string literals are
// preserved verbatim — only comments are removed.
function stripComments(source: string): string {
  let out = "";
  let state:
    | "code"
    | "line"
    | "block"
    | "single"
    | "double"
    | "template" = "code";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    switch (state) {
      case "code":
        if (c === "/" && next === "/") {
          state = "line";
          i++;
        } else if (c === "/" && next === "*") {
          state = "block";
          i++;
        } else if (c === "'") {
          state = "single";
          out += c;
        } else if (c === '"') {
          state = "double";
          out += c;
        } else if (c === "`") {
          state = "template";
          out += c;
        } else {
          out += c;
        }
        break;
      case "line":
        // Keep the newline so line numbers / ordering are unperturbed.
        if (c === "\n") {
          state = "code";
          out += c;
        }
        break;
      case "block":
        if (c === "*" && next === "/") {
          state = "code";
          i++;
        }
        break;
      case "single":
      case "double":
      case "template": {
        out += c;
        const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
        if (c === "\\") {
          // Preserve the escaped char verbatim.
          out += source[i + 1] ?? "";
          i++;
        } else if (c === quote) {
          state = "code";
        }
        break;
      }
    }
  }
  return out;
}

function sliceFrom(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Could not find marker: ${startMarker}`);
  }

  if (!endMarker) {
    return source.slice(start);
  }

  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Could not find end marker: ${endMarker}`);
  }

  return source.slice(start, end);
}

// #1159 / #1881: the person-night guard is only race-free across lodges if
// every member-linked guest-night writer takes its per-lodge capacity lock
// BEFORE invoking the guard, whose first authoritative action takes sorted
// per-member locks. indexOf proves the lodge -> member-family source ordering;
// each writer was separately confirmed to run both markers in one transaction.
function assertLockBeforeGuard(rawBlock: string, label: string) {
  // #1881 — tightened from "either lock marker" to the SPECIFIC per-lodge
  // capacity lock. Every member-linked guest writer claims beds for a lodge, so
  // it must hold `acquireLodgeCapacityLock` before the guard. (The cross-lodge
  // half of the person-night invariant is enforced separately: the guard itself
  // self-takes the per-member `booking-member-night` lock — pinned by the
  // two-tier-protocol test. Accepting a bare `pg_advisory_xact_lock` here was
  // the laxity that masked money/status writers drifting off the shared key.)
  // Strip comments first so a commented-out lock/guard can't satisfy indexOf.
  const block = stripComments(rawBlock);
  const lockIdx = block.indexOf("acquireLodgeCapacityLock");
  const guardIdx = block.indexOf("assertNoBookingMemberNightConflicts");
  expect(lockIdx, `${label}: per-lodge capacity lock present`).toBeGreaterThanOrEqual(0);
  expect(
    guardIdx,
    `${label}: person-night guard runs after the per-lodge lock`
  ).toBeGreaterThan(lockIdx);
}

// #1529: the two request-approval pipelines delegate the person-night guard to
// buildApprovalGuestCreates (booking-request-shared.ts), which runs it against
// the caller's tx — lock-first stays the caller's responsibility, same
// two-half idiom as the modify pipeline's delegated-guard test below.
function assertLockBeforeDelegatedGuard(
  rawBlock: string,
  delegateMarker: string,
  label: string
) {
  // #1881 — require the specific per-lodge capacity lock (see assertLockBeforeGuard).
  // Strip comments first so a commented-out lock/delegation can't satisfy indexOf.
  const block = stripComments(rawBlock);
  const lockIdx = block.indexOf("acquireLodgeCapacityLock");
  const delegateIdx = block.indexOf(delegateMarker);
  expect(lockIdx, `${label}: per-lodge capacity lock present`).toBeGreaterThanOrEqual(0);
  expect(
    delegateIdx,
    `${label}: ${delegateMarker} delegated after the advisory lock`
  ).toBeGreaterThan(lockIdx);
}

function createTempMigration(
  sql: string,
  ledger: string,
  // Far-future default so fixtures sort after every gate baseline. Override to
  // a pre-baseline timestamp to exercise the session-clock DML exemption.
  migrationName = "20990101000000_test_migration"
) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "tac-migration-safety-"));
  // Test fixture: joins a freshly created temp dir with a test-controlled migration name; no user input.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const migrationDir = path.join(tempDir, migrationName);
  // Test fixture: appends the hardcoded "migration.sql" filename to the temp migration dir.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const migrationPath = path.join(migrationDir, "migration.sql");
  const ledgerPath = path.join(tempDir, "safety.tsv");

  mkdirSync(migrationDir, { recursive: true });
  writeFileSync(migrationPath, sql);
  writeFileSync(ledgerPath, ledger);

  return { tempDir, migrationPath, ledgerPath };
}

function runMigrationSafetyValidator(
  migrationPath: string,
  ledgerPath: string,
  env: Record<string, string> = {}
) {
  return spawnSync("bash", ["scripts/validate-blue-green-migrations.sh", migrationPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MIGRATION_SAFETY_LEDGER: ledgerPath,
      ...env,
    },
    encoding: "utf8",
  });
}

const LEDGER_HEADER =
  "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan";

function createTempMigrationsTree(
  migrations: { name: string; sql: string }[],
  ledger: string
) {
  const tempDir = mkdtempSync(path.join(tmpdir(), "tac-migration-coverage-"));
  const migrationsDir = path.join(tempDir, "migrations");
  const ledgerPath = path.join(tempDir, "safety.tsv");

  for (const migration of migrations) {
    // Test fixture: joins the temp migrations dir with a test-controlled migration name; no user input.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    const dir = path.join(migrationsDir, migration.name);
    mkdirSync(dir, { recursive: true });
    // Test fixture: appends the hardcoded "migration.sql" filename to the temp migration dir.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
    writeFileSync(path.join(dir, "migration.sql"), migration.sql);
  }
  writeFileSync(ledgerPath, ledger);

  return { tempDir, migrationsDir, ledgerPath };
}

function runMigrationSafetyCoverage(
  env: Record<string, string> = {}
) {
  return spawnSync("bash", ["scripts/check-migration-safety-coverage.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });
}

describe("review finding source/schema contracts", () => {
  it("keeps guest chore token links read-only", () => {
    const source = readRepoFile("src/app/api/chores/[token]/route.ts");
    const putBlock = sliceFrom(source, "export async function PUT");

    expect(putBlock).not.toContain("Public endpoint");
    expect(putBlock).not.toContain("auth(");
    expect(putBlock).not.toContain("validateGuestChoreToken");
    expect(putBlock).not.toContain("choreAssignment.update");
    expect(putBlock).toContain("status: 405");
    expect(putBlock).toContain('Allow: "GET"');
  });

  it("wraps draft booking creation in the advisory-lock transaction", () => {
    // Booking creation lives in the booking-create service; the route handler
    // delegates here. Scan the service for the architectural invariants.
    const source = readRepoFile("src/lib/booking-create.ts");
    const draftBlock = sliceFrom(
      source,
      "export async function createDraftBooking",
      "export async function createConfirmedBooking"
    );

    expect(draftBlock).toContain("prisma.$transaction");
    // The capacity lock is per-lodge since multi-lodge phase 3; the contract
    // is that draft creation stays serialized under the capacity lock.
    expect(draftBlock).toContain("acquireLodgeCapacityLock(tx,");
    expect(draftBlock).toContain("tx.booking.create");
    expect(draftBlock).toMatch(/redeemPromoCode\(\s*tx,/);
    expect(draftBlock).not.toContain("prisma.booking.create");
    expect(draftBlock).not.toMatch(/redeemPromoCode\(\s*prisma,/);
  });

  it("wraps waitlist booking creation in a transaction instead of standalone Prisma writes", () => {
    const source = readRepoFile("src/lib/booking-create.ts");
    const createWaitlistedBookingBlock = sliceFrom(
      source,
      "export async function createWaitlistedBooking"
    );

    expect(createWaitlistedBookingBlock).toContain("prisma.$transaction");
    expect(createWaitlistedBookingBlock).toContain("acquireLodgeCapacityLock(tx,");
  });

  it("takes the booking advisory lock before the person-night guard in every same-transaction member-linked guest writer", () => {
    // #1159: freeze lock->guard ordering for every writer that persists a
    // member-linked BookingGuest/BookingGuestNight and runs the guard in the
    // same transaction. (The modify guest-edit path delegates its guard to a
    // helper and is frozen by the next test; group-booking's non-member join
    // path carries no member guest, so the guard is a no-op there and is out of
    // scope by design.)
    const bookingCreate = readRepoFile("src/lib/booking-create.ts");
    assertLockBeforeGuard(
      sliceFrom(
        bookingCreate,
        "export async function createDraftBooking",
        "export async function createConfirmedBooking"
      ),
      "createDraftBooking"
    );
    assertLockBeforeGuard(
      sliceFrom(
        bookingCreate,
        "export async function createConfirmedBooking",
        "export async function createWaitlistedBooking"
      ),
      "createConfirmedBooking"
    );
    assertLockBeforeGuard(
      sliceFrom(bookingCreate, "export async function createWaitlistedBooking"),
      "createWaitlistedBooking"
    );

    assertLockBeforeGuard(
      sliceFrom(
        readRepoFile("src/lib/booking-date-modification-service.ts"),
        "export async function modifyBookingDates"
      ),
      "modifyBookingDates"
    );

    // #1529: both approval pipelines now delegate the guard to
    // buildApprovalGuestCreates inside the same transaction; freeze
    // lock -> delegation per caller here, and the guard inside the shared
    // helper once (below, after the callers).
    assertLockBeforeDelegatedGuard(
      sliceFrom(
        readRepoFile("src/lib/booking-request.ts"),
        "export async function approveBookingRequest",
        "export async function purgeExpiredBookingRequests"
      ),
      "buildApprovalGuestCreates(",
      "approveBookingRequest"
    );

    assertLockBeforeGuard(
      sliceFrom(
        readRepoFile("src/lib/booking-request-quotes.ts"),
        "export async function holdBookingRequestSlots"
      ),
      "holdBookingRequestSlots"
    );

    assertLockBeforeDelegatedGuard(
      sliceFrom(
        readRepoFile("src/lib/school-booking-request.ts"),
        "export async function approveSchoolBookingRequest"
      ),
      "buildApprovalGuestCreates(",
      "approveSchoolBookingRequest"
    );

    // Second half of the #1529 delegation contract: the shared helper both
    // pipelines call actually runs the person-night guard.
    const requestShared = readRepoFile("src/lib/booking-request-shared.ts");
    expect(
      sliceFrom(
        requestShared,
        "export async function buildApprovalGuestCreates",
        "export async function sendOwnerSubstitutionAdminAlert"
      )
    ).toContain("assertNoBookingMemberNightConflicts");

    assertLockBeforeGuard(
      sliceFrom(
        readRepoFile("src/app/api/bookings/[id]/guests/route.ts"),
        "export async function POST"
      ),
      "guests route POST (member self-add)"
    );
  });

  it("keeps the modify pipeline's advisory lock ahead of its delegated person-night guard", () => {
    // The guest-editing modify path (single + batch) runs through
    // modifyBookingBatch, which takes the advisory lock and then delegates the
    // person-night guard to prepareGuestPlan inside the SAME transaction: the
    // guard runs against the passed-in tx, so taking the lock first is the
    // caller's responsibility. Freeze both halves of that contract.
    const batchService = readRepoFile(
      "src/lib/booking-batch-modification-service.ts"
    );
    const modifyBlock = stripComments(
      sliceFrom(batchService, "export async function modifyBookingBatch")
    );
    const lockMarkers = ["acquireLodgeCapacityLock", "pg_advisory_xact_lock"]
      .map((marker) => modifyBlock.indexOf(marker))
      .filter((idx) => idx >= 0);
    const lockIdx = lockMarkers.length > 0 ? Math.min(...lockMarkers) : -1;
    const delegateIdx = modifyBlock.indexOf("prepareGuestPlan(");
    expect(lockIdx, "modifyBookingBatch: advisory lock present").toBeGreaterThanOrEqual(0);
    expect(
      delegateIdx,
      "modifyBookingBatch: prepareGuestPlan delegated after the advisory lock"
    ).toBeGreaterThan(lockIdx);

    const plan = readRepoFile("src/lib/booking-modify-plan.ts");
    const prepareBlock = stripComments(
      sliceFrom(
        plan,
        "export async function prepareGuestPlan",
        "export async function loadActiveSeasonRates"
      )
    );
    expect(prepareBlock).toContain("assertNoBookingMemberNightConflicts");
  });

  it("pins the specific advisory-lock key per writer class (two-tier protocol, #1881)", () => {
    // The pre-#1881 lock-before-guard checks accepted EITHER lock marker, which
    // masked the real defect: money/status writers stayed on the global lock(1)
    // while their capacity-claiming counterparties moved to the per-lodge key,
    // so they no longer mutually excluded. Pin the SPECIFIC key(s) each writer
    // class must hold.
    const GLOBAL = "pg_advisory_xact_lock(1)";
    const PER_LODGE = "acquireLodgeCapacityLock";

    // (1) Money / booking-status transitions MUST take the global lock(1) so
    // they mutually exclude across the whole booking/settlement regardless of
    // lodge. Each entry is [file, startMarker, endMarker?].
    const globalLockBlocks: Array<[string, string, string?]> = [
      // Stripe capture + capacity-failed void.
      [
        "src/lib/payment-reconciliation.ts",
        "export async function markBookingPaymentSucceeded",
        "export async function markBookingSetupIntentSucceeded",
      ],
      // Group settle, refund-mark, and reaper share lock(1) with each other.
      [
        "src/lib/group-settlement.ts",
        "async function settleConfirmedChildrenAndNotify",
        "export async function applyGroupSettlementSucceeded",
      ],
      // End marker added (#1881) so this block no longer swallows
      // markGroupSettlementIntentFailed — each mark is asserted on its own body.
      [
        "src/lib/group-settlement.ts",
        "export async function markGroupSettlementIntentRefunded",
        "export async function markGroupSettlementIntentFailed",
      ],
      // markGroupSettlementIntentFailed also takes lock(1) since #1881 (it took
      // none before, contradicting the doc's "all take lock(1)" claim).
      [
        "src/lib/group-settlement.ts",
        "export async function markGroupSettlementIntentFailed",
      ],
      ["src/lib/cron-group-settlement-reaper.ts", "async function releaseSettlementChildren"],
      ["src/lib/group-cancel.ts", "export async function settleGroupBookingOnOrganiserCancel"],
      // Cancel + quote hold-release crons.
      ["src/lib/booking-cancel.ts", "export async function cancelBooking"],
      ["src/lib/cron-quote-expiry-reminders.ts", "async function releaseExpiredQuoteHolds"],
    ];
    for (const [file, start, end] of globalLockBlocks) {
      // #1881 — strip comments so a commented-out `pg_advisory_xact_lock(1)`
      // (which appears in comments in booking-cancel.ts and
      // cron-quote-expiry-reminders.ts) cannot satisfy the presence check.
      const block = stripComments(sliceFrom(readRepoFile(file), start, end));
      expect(block, `${start}: takes the global lock(1)`).toContain(GLOBAL);
    }

    // (2) Writers that do BOTH tiers (money/status + capacity claim) MUST take
    // the global lock(1) BEFORE the per-lodge lock (consistent global→per-lodge
    // order, deadlock-safe).
    const twoLockBlocks: Array<[string, string, string?]> = [
      [
        "src/lib/payment-reconciliation.ts",
        "export async function markBookingPaymentSucceeded",
        "export async function markBookingSetupIntentSucceeded",
      ],
      [
        "src/lib/booking-request.ts",
        "export async function approveBookingRequest",
        "export async function purgeExpiredBookingRequests",
      ],
      [
        "src/app/api/payments/switch-to-internet-banking/route.ts",
        "const paymentResult = await prisma.$transaction",
      ],
      [
        "src/lib/booking-batch-modification-service.ts",
        "export async function modifyBookingBatch",
      ],
      // #1881 — previously-unpinned two-tier writers (money/status + capacity).
      // The date-modification services both claim beds under a per-lodge lock
      // after the global lock(1).
      [
        "src/lib/booking-date-modification-service.ts",
        "export async function modifyBookingDates",
        "export async function adminShiftBookingDates",
      ],
      [
        "src/lib/booking-date-modification-service.ts",
        "export async function adminShiftBookingDates",
      ],
      // Guest removal recomputes price/capacity under both locks.
      [
        "src/lib/booking-guest-removal-service.ts",
        "export async function removeBookingGuestInTransaction",
        "export async function loadSeasonRateData",
      ],
      // F11 waitlist-confirm $0 PAID claim: a net-new capacity claim to a
      // capacity-holding status, so lock(1) then the per-lodge lock.
      [
        "src/app/api/bookings/[id]/waitlist-confirm/route.ts",
        "if (booking.finalPriceCents === 0 && result.newStatus === BookingStatus.PAYMENT_PENDING)",
      ],
      // Split-child cascade: cancellation moves booking status while the
      // confirm-pending cron can claim the same child at its lodge.
      [
        "src/lib/booking-cancel.ts",
        "async function cancelLinkedProvisionalChildBookings",
        "async function performBookingCancellation",
      ],
    ];
    for (const [file, start, end] of twoLockBlocks) {
      // #1881 — strip comments so neither lock marker can be satisfied by a
      // comment mentioning the lock rather than the executable acquisition.
      const block = stripComments(sliceFrom(readRepoFile(file), start, end));
      const globalIdx = block.indexOf(GLOBAL);
      const lodgeIdx = block.indexOf(PER_LODGE);
      expect(globalIdx, `${start}: takes the global lock(1)`).toBeGreaterThanOrEqual(0);
      expect(lodgeIdx, `${start}: takes the per-lodge lock`).toBeGreaterThanOrEqual(0);
      expect(
        globalIdx,
        `${start}: global lock(1) is acquired BEFORE the per-lodge lock`
      ).toBeLessThan(lodgeIdx);
    }

    // The split-child residual must keep the full claim shape, not merely both
    // lock markers: lock -> re-read -> guarded claim -> side effects.
    const splitChild = stripComments(
      sliceFrom(
        readRepoFile("src/lib/booking-cancel.ts"),
        "async function cancelLinkedProvisionalChildBookings",
        "async function performBookingCancellation"
      )
    );
    const splitGlobalIdx = splitChild.indexOf(GLOBAL);
    const splitLodgeIdx = splitChild.indexOf(PER_LODGE);
    const splitRereadIdx = splitChild.indexOf("tx.booking.findUnique");
    const splitClaimIdx = splitChild.indexOf("tx.booking.updateMany");
    const splitSideEffectIdx = splitChild.indexOf(
      "reconcileCancelledBookingBedAllocations"
    );
    expect(splitGlobalIdx).toBeLessThan(splitLodgeIdx);
    expect(splitLodgeIdx).toBeLessThan(splitRereadIdx);
    expect(splitRereadIdx).toBeLessThan(splitClaimIdx);
    expect(splitClaimIdx).toBeLessThan(splitSideEffectIdx);
    expect(splitChild).toContain("released.count === 0");
    expect(splitChild).toContain("fresh.status !== BookingStatus.PENDING");

    // The exclusive whole-lodge hold is a per-lodge writer added by PR #1911.
    // Its conflict response and audit dates are part of the safety contract, so
    // a mutable pre-lock snapshot is not sufficient: immutable key -> lock ->
    // full re-read -> guarded write -> conflict read.
    const exclusiveHold = stripComments(
      readRepoFile("src/app/api/admin/bookings/[id]/exclusive-hold/route.ts")
    );
    const exclusivePreReadIdx = exclusiveHold.indexOf("const lockTarget =");
    const exclusiveLockIdx = exclusiveHold.indexOf(
      `${PER_LODGE}(tx, lockTarget.lodgeId)`
    );
    const exclusiveRereadIdx = exclusiveHold.indexOf(
      "const booking = await tx.booking.findUnique"
    );
    const exclusiveWriteIdx = exclusiveHold.indexOf("tx.booking.updateMany");
    const exclusiveConflictIdx = exclusiveHold.indexOf(
      "findOverlappingCapacityHoldingBookings(tx"
    );
    const exclusivePreLockRead = exclusiveHold.slice(
      exclusivePreReadIdx,
      exclusiveLockIdx
    );
    expect(exclusivePreReadIdx).toBeGreaterThanOrEqual(0);
    expect(exclusivePreLockRead).toContain("select: { lodgeId: true }");
    expect(exclusivePreLockRead).not.toContain("checkIn");
    expect(exclusivePreReadIdx).toBeLessThan(exclusiveLockIdx);
    expect(exclusiveLockIdx).toBeLessThan(exclusiveRereadIdx);
    expect(exclusiveRereadIdx).toBeLessThan(exclusiveWriteIdx);
    expect(exclusiveWriteIdx).toBeLessThan(exclusiveConflictIdx);

    // (3) confirm-pending-guests: both capacity-claiming branches take BOTH
    // locks (the whole handler is scanned; it contains lock(1) and the per-lodge
    // lock, each ahead of its status-guarded claim). Comment-stripped so a
    // commented mention of either lock cannot satisfy the check.
    const confirmPending = stripComments(
      readRepoFile(
        "src/app/api/admin/bookings/[id]/confirm-pending-guests/route.ts"
      )
    );
    expect(confirmPending).toContain(GLOBAL);
    expect(confirmPending).toContain(`${PER_LODGE}(tx, booking.lodgeId)`);

    // (4) The member-night guard self-takes the PER-MEMBER lock across lodges,
    // since capacity locks are per-lodge only and the invariant spans lodges.
    const memberNight = stripComments(
      readRepoFile("src/lib/booking-member-night-conflicts.ts")
    );
    const assertBlock = sliceFrom(
      memberNight,
      "export async function assertNoBookingMemberNightConflicts"
    );
    expect(assertBlock).toContain("lockBookingMemberNights");
    expect(memberNight).toContain('"booking-member-night"');

    // (5) F10 credit-note-repairs: the account-credit allocation repair claims
    // the member credit ledger under the PER-MEMBER lockMemberCreditLedger key
    // (hashtext("member-credit-ledger"), hashtext(memberId)) — NOT the global
    // lock(1) the pre-#1881 repair took, which did not exclude the concurrent
    // credit writers on that member. Comment-stripped so a commented mention
    // cannot satisfy the check.
    const creditNoteRepairs = stripComments(
      readRepoFile("src/lib/xero-inbound/credit-note-repairs.ts")
    );
    const repairBlock = sliceFrom(
      creditNoteRepairs,
      "export async function repairAccountCreditAllocationBusinessState"
    );
    expect(
      repairBlock,
      "repairAccountCreditAllocationBusinessState: takes lockMemberCreditLedger"
    ).toContain("lockMemberCreditLedger(");
    const memberCredit = readRepoFile("src/lib/member-credit.ts");
    expect(memberCredit).toContain('"member-credit-ledger"');

    // (6) #1887 integrates with #1881's later lock topology: cancel and IB
    // expiry take global booking/money first, then the member-ledger lock, and
    // only then inspect/repair precise Xero allocation state.
    const cancelSource = stripComments(
      readRepoFile("src/lib/booking-cancel.ts")
    );
    const neverCapturedCancel = sliceFrom(
      cancelSource,
      "if (!paidRefundPathEligible)",
      "if (!claim.claimed)"
    );
    const cancelGlobal = neverCapturedCancel.indexOf(GLOBAL);
    const cancelMember = neverCapturedCancel.indexOf("lockMemberCreditLedger(");
    const cancelDeallocation = neverCapturedCancel.indexOf(
      "findUnconvergedAppliedCreditDeallocation("
    );
    expect(cancelGlobal).toBeGreaterThanOrEqual(0);
    expect(cancelMember).toBeGreaterThan(cancelGlobal);
    expect(cancelDeallocation).toBeGreaterThan(cancelMember);

    const expirySource = stripComments(
      readRepoFile("src/lib/internet-banking-payment-cron.ts")
    );
    const releaseHold = sliceFrom(
      expirySource,
      "function releaseOneHold",
      "export async function releaseExpiredInternetBankingHolds"
    );
    const expiryGlobal = releaseHold.indexOf(GLOBAL);
    const expiryMember = releaseHold.indexOf("lockMemberCreditLedger(");
    const expiryDeallocation = releaseHold.indexOf(
      "findUnconvergedAppliedCreditDeallocation("
    );
    expect(expiryGlobal).toBeGreaterThanOrEqual(0);
    expect(expiryMember).toBeGreaterThan(expiryGlobal);
    expect(expiryDeallocation).toBeGreaterThan(expiryMember);
  });

  it("restores a failed second-stage zero-dollar waitlist claim to a retryable state (#1881 F11)", () => {
    const source = stripComments(
      readRepoFile("src/app/api/bookings/[id]/waitlist-confirm/route.ts")
    );
    const zeroDollar = sliceFrom(
      source,
      "if (booking.finalPriceCents === 0 && result.newStatus === BookingStatus.PAYMENT_PENDING)",
      "if (result.newStatus === BookingStatus.PENDING"
    );
    const capacityFailure = sliceFrom(
      zeroDollar,
      "if (!available)",
      "await tx.payment.create"
    );
    expect(capacityFailure).toContain("tx.booking.updateMany");
    expect(capacityFailure).toContain("status: BookingStatus.WAITLISTED");
    expect(capacityFailure).toContain("status: BookingStatus.PAYMENT_PENDING");
  });

  it("runs the opt-in concurrency race harness against its dedicated CI PostgreSQL service (#1881)", () => {
    const workflow = readRepoFile(".github/workflows/ci.yml");
    expect(workflow).toContain("concurrency-race-postgres:");
    expect(workflow).toContain("POSTGRES_DB: concurrency_race_1881");
    expect(workflow).toContain("55442:5432");
    expect(workflow).toContain('RUN_CONCURRENCY_RACE_TESTS: "1"');
    expect(workflow).toContain(
      "CONCURRENCY_RACE_DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881"
    );
    const migrateStep = workflow.indexOf(
      "name: Migrate dedicated advisory-lock race database"
    );
    const raceStep = workflow.indexOf(
      "name: Test advisory-lock race protocol against dedicated PostgreSQL"
    );
    expect(migrateStep).toBeGreaterThan(-1);
    expect(raceStep).toBeGreaterThan(migrateStep);
    const migrationBlock = workflow.slice(migrateStep, raceStep);
    expect(migrationBlock).toContain(
      "DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:55442/concurrency_race_1881"
    );
    expect(migrationBlock).toContain("run: npx prisma migrate deploy");
    expect(migrationBlock).not.toContain("drift_main");
    expect(workflow).toContain(
      "npx vitest run src/lib/__tests__/concurrency-lock-races.realdb.test.ts"
    );
  });

  it("wraps age-up membership upgrades and token issuance in a transaction", () => {
    const source = readRepoFile("src/lib/cron-age-up.ts");

    expect(source).toContain("prisma.$transaction");
  });

  it("uses stable booking-modification idempotency keys instead of Date.now()", () => {
    const modifyRoute = readRepoFile("src/app/api/bookings/[id]/modify/route.ts");
    const modifyDatesRoute = readRepoFile(
      "src/app/api/bookings/[id]/modify-dates/route.ts"
    );
    const guestsRoute = readRepoFile("src/app/api/bookings/[id]/guests/route.ts");

    expect(modifyRoute).not.toContain("Date.now()");
    expect(modifyDatesRoute).not.toContain("Date.now()");
    expect(guestsRoute).not.toContain("Date.now()");
  });

  it("persists executed Stripe refunds as first-class records instead of only cumulative totals", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const paymentTransactions = readRepoFile("src/lib/payment-transactions.ts");
    const stripeWebhook = [
      readRepoFile("src/app/api/webhooks/stripe/route.ts"),
      readRepoFile("src/lib/stripe-webhook-service.ts"),
    ].join("\n");

    expect(schema).toMatch(/model\s+(?!RefundRequest\b)\w*Refund\w*\s*\{/);
    expect(schema).toContain("stripeRefundId");
    expect(schema).toContain("stripeChargeId");
    expect(schema).toContain("stripePaymentIntentId");
    expect(schema).toContain("currency");
    expect(schema).toContain("status");
    expect(paymentTransactions).toContain("paymentRefund.upsert");
    expect(paymentTransactions).toContain("recordStripeRefundLedgerEntry");
    expect(stripeWebhook).toContain("listRefundsForCharge");
    expect(stripeWebhook).toContain("syncRefundsFromStripeCharge");
  });

  it("documents BookingEvent as narrative facts rather than the full transition ledger", () => {
    const source = readRepoFile("src/lib/booking-events.ts");
    const docs = readRepoFile("docs/STATE_MACHINES.md");

    expect(source).toContain("not a complete transition");
    expect(source).toContain("durable narrative fact store");
    expect(source).toContain("Status fields, AuditLog, CronJobRun");
    expect(source).not.toContain("Every booking/payment transition writes one BookingEvent");
    expect(docs).toContain("### BookingEvent Scope");
    expect(docs).toContain("not the complete transition");
    expect(docs).toContain("payment, transaction, refund, recovery, and Xero outbox ledgers");
  });

  it("does not rely on regex tag stripping in the booking notes route", () => {
    const source = readRepoFile("src/app/api/bookings/[id]/notes/route.ts");

    expect(source).not.toContain("function stripHtmlTags");
    expect(source).not.toContain("/<[^>]*>/g");
  });

  it("renders NZ-local expiry timestamps in email verification and email-change templates", () => {
    const source = readRepoFile("src/lib/email-templates.ts");
    const verificationTemplateBlock = sliceFrom(
      source,
      "export function emailVerificationTemplate",
      "export function nominationRequestTemplate"
    );
    const emailChangeTemplateBlock = sliceFrom(
      source,
      "export function emailChangeVerificationTemplate",
      "export function emailChangeNotificationTemplate"
    );

    expect(verificationTemplateBlock).toContain("formatNZDateTime");
    expect(verificationTemplateBlock).not.toContain("This link expires in 24 hours");
    expect(emailChangeTemplateBlock).toContain("formatNZDateTime");
    expect(emailChangeTemplateBlock).not.toContain("This link expires in 1 hour");
  });

  it("surfaces email-change outcome query state on the profile page", () => {
    const source = readRepoFile("src/app/(authenticated)/profile/page.tsx");

    expect(source).toContain("emailChangeError");
    expect(source).toContain("emailChanged");
  });

  it("validates booking-cancel mutations and removes guest-chore token mutations", () => {
    const cancelRoute = readRepoFile("src/app/api/bookings/[id]/cancel/route.ts");
    const guestChoreRoute = readRepoFile("src/app/api/chores/[token]/route.ts");
    const schemaPattern = /z\.(object|enum|string|number)|safeParse\(|\.parse\(/;

    expect(cancelRoute).toMatch(schemaPattern);
    expect(guestChoreRoute).not.toContain("guestChoreMutationSchema");
    expect(guestChoreRoute).not.toContain("choreAssignment.update");
    expect(cancelRoute).not.toContain('default to "card"');
  });

  it("rate-limits public token-bearing verification and guest-chore routes", () => {
    const verifyEmailRoute = readRepoFile("src/app/api/auth/verify-email/route.ts");
    const confirmEmailChangeRoute = readRepoFile(
      "src/app/api/auth/confirm-email-change/route.ts"
    );
    const guestChoreRoute = readRepoFile("src/app/api/chores/[token]/route.ts");

    expect(verifyEmailRoute).toContain("applyRateLimit");
    expect(confirmEmailChangeRoute).toContain("applyRateLimit");
    expect(guestChoreRoute).toContain("applyRateLimit");
  });

  it("uses schemas for the remaining manual query and search parsing routes", () => {
    const schemaPattern = /z\.(object|enum|string|number)|safeParse\(|\.parse\(/;
    const routes = [
      "src/app/api/availability/route.ts",
      "src/app/api/availability/check/route.ts",
      "src/app/api/booking-policies/check/route.ts",
      "src/app/api/admin/bookings/search/route.ts",
      "src/app/api/admin/xero/search-contacts/route.ts",
      "src/app/api/admin/xero/sync-memberships/route.ts",
    ];

    for (const route of routes) {
      expect(readRepoFile(route)).toMatch(schemaPattern);
    }
  });

  it("adds the missing foreign-key indexes for Booking.createdById and FamilyGroupJoinRequest.linkedMemberId", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const bookingBlock = sliceFrom(schema, "model Booking {", "model Payment {");
    const familyGroupJoinRequestBlock = sliceFrom(
      schema,
      "model FamilyGroupJoinRequest {",
      "model NotificationPreference {"
    );

    expect(bookingBlock).toContain("@@index([createdById])");
    expect(familyGroupJoinRequestBlock).toContain("@@index([linkedMemberId])");
  });

  it("keeps financial-history relations from cascading deletes off Member and Booking", () => {
    const schema = readRepoFile("prisma/schema.prisma");

    // The original finding banned exact relation lines, which broke on any
    // unrelated model whose formatting coincided (e.g. the ADR-004 waitlist
    // opt-in junction, which legitimately cascades with its booking). Assert
    // the actual invariant instead: within each financial-history model, no
    // relation to Booking or Member may cascade, regardless of formatting.
    const FINANCIAL_HISTORY_MODELS = [
      "BookingEvent",
      "Payment",
      "PaymentTransaction",
      "PaymentRefund",
      "RefundRequest",
      "MemberCredit",
      "AdminCreditAdjustmentRequest",
      "PaymentRecoveryOperation",
    ];
    for (const model of FINANCIAL_HISTORY_MODELS) {
      const block = schema.match(
        new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "m")
      );
      expect(block, `model ${model} missing from schema`).not.toBeNull();
      const offending = (block![0].match(/^.*@relation.*$/gm) ?? []).filter(
        (line) =>
          /\b(Booking|Member)\b\s+@relation/.test(line) &&
          line.includes("onDelete: Cascade")
      );
      expect(offending, `${model} cascades off Booking/Member`).toEqual([]);
    }
  });

  it("serializes stale waitlist-offer expiry and re-offer selection behind a transaction", () => {
    const source = readRepoFile("src/lib/waitlist.ts");
    const expireStaleOffersBlock = sliceFrom(
      source,
      "export async function expireStaleOffers",
      "// test seam"
    );

    expect(expireStaleOffersBlock).toContain("prisma.$transaction");
    expect(expireStaleOffersBlock).toContain("acquireLodgeCapacityLock");
  });

  it("adds SES bounce and complaint ingestion instead of retry-only email recovery", () => {
    const emailCronSource = readRepoFile("src/lib/cron-email-retry.ts");
    const emailSource = readRepoFile("src/lib/email.ts");
    const emailSenderSource = readRepoFile("src/lib/email-sender.ts");
    const suppressionSource = readRepoFile("src/lib/email-suppression.ts");
    const snsRoute = readRepoFile("src/app/api/webhooks/ses-sns/route.ts");
    const sesSnsVerifier = readRepoFile("src/lib/ses-sns.ts");
    const schema = readRepoFile("prisma/schema.prisma");
    const combined = `${emailCronSource}\n${emailSource}\n${emailSenderSource}\n${suppressionSource}\n${snsRoute}\n${sesSnsVerifier}`;

    expect(combined).toMatch(/bounce|complaint/i);
    expect(combined).toMatch(/sns|ses/i);
    expect(combined).toContain("verifySnsWebhookMessage");
    expect(combined).toContain("getActiveEmailSuppression");
    expect(schema).toContain("model EmailSuppression");
  });

  it("keeps nomination token page and confirmation lookups hashed at rest", () => {
    const pageSource = readRepoFile("src/app/(authenticated)/nominations/[token]/page.tsx");
    const nominationSource = readRepoFile("src/lib/nomination.ts");
    const schema = readRepoFile("prisma/schema.prisma");

    expect(schema).toContain("model NominationToken");
    expect(schema).toContain("tokenHash");
    expect(schema).not.toContain("token             String    @unique");
    expect(pageSource).toContain("hashActionToken(token)");
    expect(nominationSource).toContain("where: { tokenHash }");
  });

  it("wires logger and Sentry through shared token scrubbing", () => {
    const loggerSource = readRepoFile("src/lib/logger.ts");
    const sentryServer = readRepoFile("sentry.server.config.ts");
    const sentryEdge = readRepoFile("sentry.edge.config.ts");

    expect(loggerSource).toMatch(/redact:|redactSensitiveJson|serializers:/);
    expect(sentryServer).toMatch(
      /redactSensitiveJson|stripeToken|stripe_token|access_token|refresh_token/
    );
    expect(sentryEdge).toMatch(
      /redactSensitiveJson|stripeToken|stripe_token|access_token|refresh_token/
    );
  });

  it("keeps the active Caddy upstream file consistent if reload fails", () => {
    const source = readRepoFile("scripts/run-production-blue-green-deploy.sh");
    const cutoverBlock = sliceFrom(source, 'step "16/19"', 'step "17/19"');
    const writeIndex = cutoverBlock.indexOf("write_active_upstream_file");
    const reloadIndex = cutoverBlock.indexOf("reload_caddy");
    const hasExplicitRestorePath =
      /restore.*upstream|previous.*upstream|original.*upstream/i.test(source);

    expect(writeIndex).toBeGreaterThan(-1);
    expect(reloadIndex).toBeGreaterThan(-1);
    expect(reloadIndex < writeIndex || hasExplicitRestorePath).toBe(true);
  });

  it("gates blue/green migrations with an explicit safety ledger", () => {
    const source = readRepoFile("scripts/run-production-blue-green-deploy.sh");
    const validator = readRepoFile("scripts/validate-blue-green-migrations.sh");
    const ledger = readRepoFile("docs/BLUE_GREEN_MIGRATION_SAFETY.tsv");

    expect(source).toContain("MIGRATION_SAFETY_LEDGER");
    expect(source).toContain("validate-blue-green-migrations.sh");
    expect(validator).toContain("HOT_TABLE_SQL_REGEX");
    expect(validator).toContain("lock impact plan");
    expect(ledger).toContain("old_code_compatible");
  });

  it("requires lock-impact documentation for hot-table migrations", () => {
    const fixture = createTempMigration(
      'ALTER TABLE "Payment" ADD COLUMN "processorReference" TEXT;\n',
      "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan\n"
    );

    try {
      const result = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("missing");
      expect(result.stderr).toContain("blue/green migration safety review");
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("allows documented hot-table expand migrations without breaking-SQL override", () => {
    const fixture = createTempMigration(
      'ALTER TABLE "Payment" ADD COLUMN "processorReference" TEXT;\n',
      [
        "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan",
        "20990101000000_test_migration\texpand\tn/a\tyes\tAdds a nullable Payment column; run during low traffic and verify no long payment writes.",
      ].join("\n")
    );

    try {
      const result = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath
      );

      expect(result.status).toBe(0);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("requires operator acknowledgement for documented destructive contract migrations", () => {
    const fixture = createTempMigration(
      'ALTER TABLE "Member" DROP COLUMN "legacyPhone";\n',
      [
        "# migration_name\tphase\tprevious_expand_release\told_code_compatible\tlock_impact_plan",
        "20990101000000_test_migration\tcontract\t20261201000000_member_phone_expand\tyes\tDrops a retired Member column after all runtime callers moved to structured phone fields.",
      ].join("\n")
    );

    try {
      const blocked = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath
      );
      const allowed = runMigrationSafetyValidator(
        fixture.migrationPath,
        fixture.ledgerPath,
        {
          ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
          BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
            "contract phase verified against previous deployed runtime",
        }
      );

      expect(blocked.status).not.toBe(0);
      expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
      expect(allowed.status).toBe(0);
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it(
    "passes a SET NOT NULL paired with a same-column non-NULL SET DEFAULT without an override (H4)",
    { timeout: 20000 },
    () => {
      // The multi-lodge contract migration (20260708001100) SET NOT NULL on
      // lodgeId while giving the same column a default_lodge_id() DEFAULT in the
      // same migration: an old (pre-lodge) colour's omitted-column INSERT gets
      // the default, so no null is written and the NOT NULL is old-code-safe. The
      // validator must treat that pairing as reviewed-safe (no ALLOW_BREAKING
      // override), while still requiring a well-formed ledger entry. LodgeRoom is
      // deliberately not a hot table, so no lock-impact plan is needed here.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT default_lodge_id();',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tPaired same-column SET DEFAULT keeps old-colour inserts non-null; no row rewrite.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for an unmatched SET NOT NULL with no same-column SET DEFAULT (H4)",
    { timeout: 20000 },
    () => {
      const fixture = createTempMigration(
        'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tSET NOT NULL with no paired default; documented as breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "unmatched NOT NULL verified old-code compatible out of band",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for a RENAME COLUMN (H4)",
    { timeout: 20000 },
    () => {
      // RENAME hits the destructive-removal regex, so the ledger must record it
      // as phase=contract naming the previous expand release (mirrors the
      // DROP COLUMN fixture) before it can even reach the breaking-SQL gate.
      const fixture = createTempMigration(
        'ALTER TABLE "LodgeRoom" RENAME COLUMN "oldName" TO "name";\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\tcontract\t20261201000000_room_rename_expand\tyes\tRenames a retired column after all readers moved to the new name.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "rename verified against previous deployed runtime",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for an ALTER COLUMN ... TYPE change (H4)",
    { timeout: 20000 },
    () => {
      const fixture = createTempMigration(
        'ALTER TABLE "LodgeRoom" ALTER COLUMN "sortOrder" TYPE BIGINT;\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tWidens a column type; documented as breaking for blue/green.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "type change verified compatible with both colours",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL paired only with SET DEFAULT NULL as vacuous (H4)",
    { timeout: 20000 },
    () => {
      // A SET DEFAULT NULL fills nothing, so an old colour's omitted-column
      // INSERT still lands a null and the NOT NULL would abort mid-cutover. The
      // pairing is vacuous: the NOT NULL must stay breaking (override required),
      // never quietly waived like a real non-null default.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tSET DEFAULT NULL does not backfill; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "NULL-default NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL paired only with a cast-form SET DEFAULT NULL as vacuous (#1587 item 7)",
    { timeout: 20000 },
    () => {
      // A cast-wrapped NULL default still fills nothing, exactly like a bare
      // SET DEFAULT NULL: an old colour's omitted-column INSERT lands a null and
      // the NOT NULL aborts mid-cutover. The validator must normalise the cast away
      // and treat the pairing as vacuous (override required), not waive it as if the
      // cast made it a real non-null default. Both cast spellings named in the spec
      // are pinned: the tight "NULL::text" and the spaced/parenthesised
      // "NULL :: varchar(10)".
      const castDefaults = ["NULL::text", "NULL :: varchar(10)"];
      for (const castDefault of castDefaults) {
        const fixture = createTempMigration(
          [
            `ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT ${castDefault};`,
            'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
            "",
          ].join("\n"),
          [
            LEDGER_HEADER,
            "20990101000000_test_migration\texpand\tn/a\tyes\tCast-form NULL default does not backfill; NOT NULL stays breaking.",
          ].join("\n")
        );

        try {
          const blocked = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath
          );
          const allowed = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath,
            {
              ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
              BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
                "cast-NULL-default NOT NULL accepted after out-of-band verification",
            }
          );

          expect(blocked.status, `${castDefault}: ${blocked.stderr}`).not.toBe(0);
          expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
          expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
          expect(allowed.status).toBe(0);
        } finally {
          rmSync(fixture.tempDir, { recursive: true, force: true });
        }
      }
    }
  );

  it(
    "rejects a SET NOT NULL whose last same-column SET DEFAULT resets to NULL (last-wins, #1587 item 7)",
    { timeout: 20000 },
    () => {
      // A non-null SET DEFAULT followed by a SET DEFAULT NULL on the same column
      // leaves the effective default NULL (last-wins). The earlier non-null value
      // must NOT waive the NOT NULL: an old colour's omitted-column INSERT still
      // lands a null once the reset applies. The validator must judge only the
      // final default, so the pairing stays vacuous (override required).
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLast SET DEFAULT resets to NULL; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "last-wins-NULL NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a SET NOT NULL whose last same-column SET DEFAULT is non-NULL (last-wins, #1587 item 7)",
    { timeout: 20000 },
    () => {
      // A SET DEFAULT NULL followed by a non-null SET DEFAULT on the same column
      // leaves the effective default non-null (last-wins): an old colour's
      // omitted-column INSERT gets the real default, so no null is written and the
      // NOT NULL is old-code-safe. The validator must waive it (reviewed no-outage,
      // no override) just like a single non-null default — the earlier NULL reset
      // must not over-correct into a false breaking flag.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLast SET DEFAULT is non-null; old-colour inserts stay non-null.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL whose default is cleared by a trailing DROP DEFAULT (#1602 gap 1)",
    { timeout: 20000 },
    () => {
      // A non-null SET DEFAULT, then SET NOT NULL, then DROP DEFAULT on the same
      // column leaves the column with NO default: an old colour's omitted-column
      // INSERT lands a null and the NOT NULL aborts mid-cutover. The trailing DROP
      // DEFAULT is the effective final default statement (last-wins across SET and
      // DROP), so the pairing is vacuous and must stay breaking (override required).
      // This waived on the pre-#1602 script, which only inspected SET DEFAULT.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" DROP DEFAULT;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tTrailing DROP DEFAULT clears the default; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "dropped-default NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a SET NOT NULL whose DROP DEFAULT precedes a later non-NULL SET DEFAULT (#1602 gap 1)",
    { timeout: 20000 },
    () => {
      // A DROP DEFAULT followed by a non-null SET DEFAULT on the same column leaves
      // the effective default non-null (last-wins): an old colour's omitted-column
      // INSERT gets the real default, so no null is written and the NOT NULL is
      // old-code-safe. An earlier DROP DEFAULT must not over-correct into a false
      // breaking flag — the validator waives it (reviewed no-outage, no override).
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" DROP DEFAULT;',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLast SET DEFAULT is non-null despite an earlier DROP DEFAULT.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects a SET NOT NULL whose SET DEFAULT NULL hides behind a trailing comment (#1602 gap 2)",
    { timeout: 20000 },
    () => {
      // "SET DEFAULT NULL; -- reset" is a vacuous NULL default, but the trailing
      // comment defeats the end-anchored NULL check on the pre-#1602 script, so it
      // waived. The comment must be stripped before classification so the pairing
      // is recognised as vacuous and stays breaking (override required).
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULL; -- reset',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tCommented SET DEFAULT NULL is still vacuous; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "commented NULL-default NOT NULL accepted after out-of-band verification",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a SET NOT NULL whose non-NULL default carries a trailing comment, with a quoted -- kept intact (#1602 gap 2)",
    { timeout: 20000 },
    () => {
      // Comment stripping must not corrupt classification of a genuine non-null
      // default: "SET DEFAULT 'x'; -- note" still waives. It also must NOT strip a
      // "--" inside a single-quoted string literal ("SET DEFAULT 'a--b'"), which
      // stays a non-null default and waives — proving the common quoted-string case
      // the spec calls out.
      for (const sql of [
        'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\'; -- note',
        "ALTER TABLE \"LodgeRoom\" ALTER COLUMN \"lodgeId\" SET DEFAULT 'a--b';",
      ]) {
        const fixture = createTempMigration(
          [
            sql,
            'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
            "",
          ].join("\n"),
          [
            LEDGER_HEADER,
            "20990101000000_test_migration\texpand\tn/a\tyes\tNon-null default with a comment / quoted dashes stays a real backfill.",
          ].join("\n")
        );

        try {
          const result = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath
          );

          expect(result.status, `${sql}: ${result.stderr}`).toBe(0);
          expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
        } finally {
          rmSync(fixture.tempDir, { recursive: true, force: true });
        }
      }
    }
  );

  it(
    "rejects a SET NOT NULL paired with a semantically-NULL default expression (#1602 gap 3)",
    { timeout: 20000 },
    () => {
      // CAST(NULL AS <type>) and a parenthesised (NULL) are semantically NULL: they
      // fill nothing, so an old colour's omitted-column INSERT lands a null and the
      // NOT NULL aborts. The pre-#1602 script only recognised a bare NULL after
      // SET DEFAULT, so these spellings waived. They must now be recognised as NULL
      // and stay breaking (override required). NULLIF(...) is deliberately out of
      // scope and is covered by the non-NULL waiver test below.
      const nullSpellings = [
        "CAST(NULL AS text)",
        "CAST(NULL AS varchar(10))",
        "(NULL)",
        "(NULL)::text",
        "( NULL )",
      ];
      for (const spelling of nullSpellings) {
        const fixture = createTempMigration(
          [
            `ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT ${spelling};`,
            'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
            "",
          ].join("\n"),
          [
            LEDGER_HEADER,
            "20990101000000_test_migration\texpand\tn/a\tyes\tSemantically-NULL default does not backfill; NOT NULL stays breaking.",
          ].join("\n")
        );

        try {
          const blocked = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath
          );
          const allowed = runMigrationSafetyValidator(
            fixture.migrationPath,
            fixture.ledgerPath,
            {
              ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
              BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
                "semantic-NULL-default NOT NULL accepted after out-of-band verification",
            }
          );

          expect(blocked.status, `${spelling}: ${blocked.stderr}`).not.toBe(0);
          expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
          expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
          expect(allowed.status).toBe(0);
        } finally {
          rmSync(fixture.tempDir, { recursive: true, force: true });
        }
      }
    }
  );

  it(
    "rejects a SET NOT NULL whose default is a same-argument NULLIF (#1602 gap 3)",
    { timeout: 20000 },
    () => {
      // NULLIF(x, x) with identical literals evaluates to NULL, so it fills
      // nothing: an old colour's omitted-column INSERT still lands a null and
      // the NOT NULL aborts mid-cutover. The issue's gap 3 lists this as a
      // common NULL spelling to enumerate; the same-argument form is recognised
      // (backref-free implementation — some greps reject ERE backreferences and
      // would otherwise fail open).
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULLIF(\'a\', \'a\');',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tSame-argument NULLIF default is semantically NULL; NOT NULL stays breaking.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(result.stderr).not.toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a SET NOT NULL whose default is a differing-argument NULLIF, kept non-NULL by design (#1602 gap 3)",
    { timeout: 20000 },
    () => {
      // NULLIF('a', 'b') evaluates to 'a' — a real non-NULL default — and, like
      // every other SQL expression beyond the enumerated spellings, classifies
      // as non-NULL: expression analysis stays out of scope. This pins the
      // boundary so only the same-argument form is treated as a NULL reset.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT NULLIF(\'a\', \'b\');',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tDiffering-argument NULLIF default classifies as non-NULL by documented choice.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "rejects an unpaired SET NOT NULL whose extraction target is retargeted by a trailing comment (#1602 review finding)",
    { timeout: 20000 },
    () => {
      // A trailing '-- ALTER COLUMN "paired"' comment on the SET NOT NULL line
      // could retarget the greedy table/column capture at the column that DOES
      // have a default, waiving the genuinely-unpaired "lodgeId" NOT NULL.
      // Extraction now runs on a comment-stripped copy of the statement.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "paired" SET DEFAULT \'x\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL; -- ALTER COLUMN "paired"',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tUnpaired NOT NULL; the comment must not retarget extraction.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a paired SET NOT NULL carrying a benign trailing comment (#1602 review finding)",
    { timeout: 20000 },
    () => {
      // Comment-stripping before extraction must not break the legitimate case:
      // a genuine non-NULL pairing whose SET NOT NULL line ends in an ordinary
      // comment still waives.
      const fixture = createTempMigration(
        [
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET DEFAULT \'seed-lodge\';',
          'ALTER TABLE "LodgeRoom" ALTER COLUMN "lodgeId" SET NOT NULL; -- backfilled in prior migration',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tNon-NULL default pairing; benign trailing comment on the NOT NULL line.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "waives a lowercase SET NOT NULL paired with a lowercase non-NULL SET DEFAULT (#1602 gap 4)",
    { timeout: 20000 },
    () => {
      // The table/column extraction is now case-insensitive on keywords, so a
      // lowercase safe pairing gets the same waiver as its uppercase form. On the
      // pre-#1602 script the case-sensitive sed extraction returned empty, so the
      // waiver branch was skipped and this BLOCKED — this is the intended
      // block->waive flip that proves fix 4.
      const fixture = createTempMigration(
        [
          'alter table "LodgeRoom" alter column "lodgeId" set default \'seed-lodge\';',
          'alter table "LodgeRoom" alter column "lodgeId" set not null;',
          "",
        ].join("\n"),
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLowercase paired default keeps old-colour inserts non-null.",
        ].join("\n")
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "requires an override for a lowercase unmatched SET NOT NULL (#1602 gap 4)",
    { timeout: 20000 },
    () => {
      // Case-insensitive extraction must not soften a genuinely breaking lowercase
      // NOT NULL: with no same-column SET DEFAULT it stays breaking (override
      // required), exactly like its uppercase counterpart. This blocks on both the
      // pre- and post-#1602 script, but for different reasons — before because the
      // extraction failed and it fell through, now because the pairing is genuinely
      // unmatched — so it is a guard, not a closed evasion.
      const fixture = createTempMigration(
        'alter table "LodgeRoom" alter column "lodgeId" set not null;\n',
        [
          LEDGER_HEADER,
          "20990101000000_test_migration\texpand\tn/a\tyes\tLowercase SET NOT NULL with no paired default; documented as breaking.",
        ].join("\n")
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const allowed = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "lowercase unmatched NOT NULL verified old-code compatible out of band",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS");
        expect(blocked.stderr).not.toContain("Reviewed no-outage NOT NULL");
        expect(allowed.status).toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "passes the committed multi-lodge NOT NULL migration override-free against the real ledger (H4)",
    { timeout: 20000 },
    () => {
      // Reviewer reproduction, CI-enforced: run the REAL file on disk (never a
      // copy) through the validator with the REAL ledger and NO override. The
      // paired same-column default_lodge_id() DEFAULT must keep it override-free,
      // so the migration header's "deploy with ALLOW_BREAKING" note stays wrong
      // and can never silently drift back to true.
      const realMigrationPath = path.resolve(
        process.cwd(),
        "prisma/migrations/20260708001100_multi_lodge_entity_lodge_id_not_null/migration.sql"
      );
      const realLedgerPath = path.resolve(
        process.cwd(),
        "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv"
      );

      const result = runMigrationSafetyValidator(
        realMigrationPath,
        realLedgerPath
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Reviewed no-outage NOT NULL");
    }
  );

  it(
    "blocks CURRENT_TIMESTAMP/now() in an INSERT or UPDATE payload, non-overridably (#1656 / #1627)",
    { timeout: 20000 },
    () => {
      // Session (DB-local) time written into a naive timestamp column renders
      // local wall-clock on a non-UTC database and skews createdAt ordering —
      // the #1627 default-lodge inversion. The gate must flag the clock even
      // when it sits several lines below the INSERT keyword (multi-line VALUES),
      // and in an UPDATE ... SET payload. It is a hard block: the
      // ALLOW_BREAKING override must NOT rescue it (unlike breaking-SQL), so the
      // PR-time coverage gate (which sets ALLOW_BREAKING=1) still enforces it.
      const fixture = createTempMigration(
        [
          'INSERT INTO "Foo" ("id", "createdAt")',
          "VALUES (",
          "  'x',",
          "  CURRENT_TIMESTAMP",
          ");",
          'UPDATE "Bar" SET "updatedAt" = now() WHERE "id" = \'y\';',
          "",
        ].join("\n"),
        `${LEDGER_HEADER}\n`
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const stillBlocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "session-clock DML is non-overridable; this must not rescue it",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("Session-clock CURRENT_TIMESTAMP/now()");
        // Both the multi-line INSERT and the UPDATE payload are reported.
        expect(blocked.stderr).toMatch(/INSERT INTO "Foo"/);
        expect(blocked.stderr).toMatch(/UPDATE "Bar"/);
        // The override cannot waive it.
        expect(stillBlocked.status, stillBlocked.stderr).not.toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "allows DDL DEFAULT CURRENT_TIMESTAMP and INSERT/UPDATE with explicit values (#1656 / #1627)",
    { timeout: 20000 },
    () => {
      // The ban is scoped to DML payloads. A column DEFAULT CURRENT_TIMESTAMP
      // (CREATE TABLE and ALTER COLUMN ... SET DEFAULT) is DDL, not an
      // INSERT/UPDATE, and an INSERT/UPDATE that writes an explicit literal is
      // fine — neither must trip the gate.
      const fixture = createTempMigration(
        [
          'CREATE TABLE "Baz" (',
          '  "id" TEXT NOT NULL,',
          '  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
          ");",
          'ALTER TABLE "Baz" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;',
          'INSERT INTO "Baz" ("id", "createdAt") VALUES (\'a\', \'2026-01-01T00:00:00Z\');',
          'UPDATE "Baz" SET "createdAt" = \'2026-01-02T00:00:00Z\' WHERE "id" = \'a\';',
          "",
        ].join("\n"),
        `${LEDGER_HEADER}\n`
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("Session-clock CURRENT_TIMESTAMP/now()");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "exempts migrations before the session-clock baseline so committed history never retro-fails (#1656 / #1627)",
    { timeout: 20000 },
    () => {
      // Existing committed migrations legitimately used CURRENT_TIMESTAMP/now()
      // in DML payloads before this gate existed (e.g. 20260708000000 seeds the
      // lodge, 20260708220000 repairs the skew with now()). The gate scopes to
      // migrations at or after the baseline; a pre-baseline name with the same
      // DML clock must pass, so the ratchet applies only going forward.
      const fixture = createTempMigration(
        'INSERT INTO "Foo" ("id", "createdAt") VALUES (\'x\', CURRENT_TIMESTAMP);\n',
        `${LEDGER_HEADER}\n`,
        "20260101000000_pre_baseline_migration"
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain("Session-clock CURRENT_TIMESTAMP/now()");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "treats a dollar-quoted body with internal semicolons as one statement so its CURRENT_TIMESTAMP is still caught (#2038)",
    { timeout: 20000 },
    () => {
      // #2038: a $cms$...$cms$ payload whose HTML entities embed literal ";"
      // (e.g. &mdash;) must not fragment before the session-clock gate. The whole
      // UPDATE — including "updatedAt" = CURRENT_TIMESTAMP after the closing $cms$
      // — is one statement, so the clock is seen and the gate blocks
      // non-overridably. Before the fix the &mdash; semicolon split the payload
      // and the CURRENT_TIMESTAMP tail lost its leading UPDATE keyword, escaping
      // the check.
      const fixture = createTempMigration(
        [
          'UPDATE "PageContent"',
          'SET "contentHtml" = $cms$<p>We do not store card numbers &mdash; Stripe does; see the policy.</p>$cms$,',
          '    "updatedAt" = CURRENT_TIMESTAMP',
          "WHERE \"slug\" = 'privacy';",
          "",
        ].join("\n"),
        `${LEDGER_HEADER}\n`
      );

      try {
        const blocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );
        const stillBlocked = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath,
          {
            ALLOW_BREAKING_BLUE_GREEN_MIGRATIONS: "1",
            BLUE_GREEN_MIGRATION_OVERRIDE_REASON:
              "session-clock DML stays non-overridable through dollar quotes",
          }
        );

        expect(blocked.status, blocked.stderr).not.toBe(0);
        expect(blocked.stderr).toContain("Session-clock CURRENT_TIMESTAMP/now()");
        expect(blocked.stderr).toMatch(/UPDATE "PageContent"/);
        expect(stillBlocked.status, stillBlocked.stderr).not.toBe(0);
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "still splits multi-statement files at real semicolons after a dollar-quoted body (#2038)",
    { timeout: 20000 },
    () => {
      // The dollar-quote awareness must not swallow the real statement separator:
      // a benign explicit-UTC UPDATE with a $cms$ body (internal ";" included)
      // followed by a SEPARATE CURRENT_TIMESTAMP UPDATE must split into two
      // statements. Only the second is flagged, and the benign body must NOT
      // appear in the flagged statement (proof the two were not merged into one).
      const fixture = createTempMigration(
        [
          'UPDATE "PageContent"',
          'SET "contentHtml" = $cms$<p>First &mdash; benignmarker; body.</p>$cms$,',
          "    \"updatedAt\" = timezone('UTC', statement_timestamp())",
          "WHERE \"slug\" = 'faq';",
          'UPDATE "OtherCold" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = \'z\';',
          "",
        ].join("\n"),
        `${LEDGER_HEADER}\n`
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain("Session-clock CURRENT_TIMESTAMP/now()");
        expect(result.stderr).toMatch(/UPDATE "OtherCold"/);
        // Split cleanly at the real ";": the benign explicit-UTC statement is not
        // part of the flagged output.
        expect(result.stderr).not.toMatch(/UPDATE "PageContent"/);
        expect(result.stderr).not.toContain("benignmarker");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "fails loudly on an unterminated dollar-quoted string instead of silently passing (#2038)",
    { timeout: 20000 },
    () => {
      // An opening $cms$ with no closing $cms$ before EOF must not let the file
      // slip through unparsed: the splitter reports the unterminated body and the
      // gate records a hard failure rather than silently passing a file it could
      // not tokenise.
      const fixture = createTempMigration(
        [
          'UPDATE "PageContent"',
          'SET "contentHtml" = $cms$<p>Never closed &mdash; oops; and CURRENT_TIMESTAMP hides here</p>,',
          '    "updatedAt" = CURRENT_TIMESTAMP',
          "WHERE \"slug\" = 'privacy';",
          "",
        ].join("\n"),
        `${LEDGER_HEADER}\n`
      );

      try {
        const result = runMigrationSafetyValidator(
          fixture.migrationPath,
          fixture.ledgerPath
        );

        expect(result.status, result.stderr).not.toBe(0);
        expect(result.stderr).toContain("Unterminated dollar-quoted string");
      } finally {
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  );

  it(
    "acknowledges the committed 20260717180000 cold-table cosmetic session-clock UPDATE against the real ledger (#2038)",
    { timeout: 20000 },
    () => {
      // End-to-end: the dollar-quote-aware splitter now SEES the CURRENT_TIMESTAMP
      // in the committed starter-copy UPDATEs (previously hidden by &mdash;
      // fragmentation), and the SESSION_CLOCK_DML_ACKNOWLEDGED allowlist records
      // the reviewed benign disposition (cold PageContent, cosmetic updatedAt), so
      // the REAL file passes override-free while the waiver stays visible in
      // stderr. Run the real file on disk, never a copy.
      const realMigrationPath = path.resolve(
        process.cwd(),
        "prisma/migrations/20260717180000_genericise_starter_lodge_copy/migration.sql"
      );
      const realLedgerPath = path.resolve(
        process.cwd(),
        "docs/BLUE_GREEN_MIGRATION_SAFETY.tsv"
      );

      const result = runMigrationSafetyValidator(
        realMigrationPath,
        realLedgerPath
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Acknowledged benign session-clock DML");
      // Not the hard-failure header.
      expect(result.stderr).not.toContain("write an explicit UTC value instead");
    }
  );

  it("flags hot-table trigger operations in the blue/green validator", () => {
    // #1359 (finding F8): 20260704100000 ran DROP TRIGGER / CREATE CONSTRAINT
    // TRIGGER on hot tables Booking/BookingGuest, but the validator's hot-table
    // regex did not cover TRIGGER operations, so it passed the deploy gate with
    // no ledger entry. The regex must now require a ledger entry for them.
    const missing = createTempMigration(
      'DROP TRIGGER "Booking_dates_consistent_with_guests" ON "Booking";\n',
      `${LEDGER_HEADER}\n`
    );
    try {
      const result = runMigrationSafetyValidator(
        missing.migrationPath,
        missing.ledgerPath
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("blue/green migration safety review");
    } finally {
      rmSync(missing.tempDir, { recursive: true, force: true });
    }

    const documented = createTempMigration(
      'DROP TRIGGER "Booking_dates_consistent_with_guests" ON "Booking";\n',
      [
        LEDGER_HEADER,
        "20990101000000_test_migration\texpand\tn/a\tyes\tSwaps a Booking trigger for a deferred constraint trigger; brief lock, no row scan.",
      ].join("\n")
    );
    try {
      const result = runMigrationSafetyValidator(
        documented.migrationPath,
        documented.ledgerPath
      );
      expect(result.status).toBe(0);
    } finally {
      rmSync(documented.tempDir, { recursive: true, force: true });
    }
  });

  it(
    "keeps the committed migration tree covered by the blue/green safety ledger",
    // Shells out over the full committed migration tree; under a loaded
    // parallel suite run this regularly exceeds the default 5s.
    { timeout: 20000 },
    () => {
      // Regression guard for #1359: the real prisma/migrations tree + real ledger
      // must pass the PR-time coverage gate (both backfilled rows present, and no
      // new duplicate timestamp prefix beyond the grandfathered set).
      const result = runMigrationSafetyCoverage();
      expect(result.status, result.stderr).toBe(0);
    },
  );

  it("fails ledger coverage when a hot-table migration at/after baseline is unledgered", () => {
    const fixture = createTempMigrationsTree(
      [
        {
          name: "20990101000000_unledgered_hot",
          sql: 'ALTER TABLE "Payment" ADD COLUMN "processorRef" TEXT;\n',
        },
      ],
      [LEDGER_HEADER, "20260507000000_base\texpand\tn/a\tyes\tbaseline row"].join(
        "\n"
      )
    );
    try {
      const result = runMigrationSafetyCoverage({
        MIGRATIONS_DIR: fixture.migrationsDir,
        MIGRATION_SAFETY_LEDGER: fixture.ledgerPath,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Ledger coverage check FAILED");
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("fails the timestamp ratchet when a new migration reuses a timestamp prefix", () => {
    const fixture = createTempMigrationsTree(
      [
        { name: "20990101000000_alpha", sql: 'CREATE TABLE "Foo" ("id" TEXT);\n' },
        { name: "20990101000000_beta", sql: 'CREATE TABLE "Bar" ("id" TEXT);\n' },
      ],
      [LEDGER_HEADER, "20260507000000_base\texpand\tn/a\tyes\tbaseline row"].join(
        "\n"
      )
    );
    try {
      const result = runMigrationSafetyCoverage({
        MIGRATIONS_DIR: fixture.migrationsDir,
        MIGRATION_SAFETY_LEDGER: fixture.ledgerPath,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Timestamp hygiene check FAILED");
    } finally {
      rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the door code legible in dark mode via a source token, not a remap (F28)", () => {
    // #1371 F28 originally relied on the `.dark .app-theme-scope` neutral remap
    // lifting a raw `text-slate-950` door code to `--foreground` in dark mode.
    // #2188 P2 DELETED that remap and migrated the door code (hut-leaders page)
    // onto `text-foreground` at source, which is legible in BOTH modes by
    // construction — the same guarantee, now correct-at-source, not by shim.
    const hutLeaders = readRepoFile("src/app/(admin)/admin/hut-leaders/page.tsx");
    // The prominent mono door-code line renders on the semantic foreground token.
    expect(hutLeaders).toMatch(/font-mono[^"]*text-foreground/);
    // And it must NOT have reverted to a raw darkest-neutral tier.
    expect(hutLeaders).not.toMatch(/text-(?:slate|gray|zinc|neutral|stone)-950/);
    // The deleted remap is gone from globals (grep-proof of the P2 deletion).
    const globals = readRepoFile("src/app/globals.css");
    expect(globals).not.toMatch(/\.dark \.app-theme-scope[\s\S]{0,80}\.text-slate-950/);
  });

  it("keeps promo review-step text on directly gated semantic/solid pairs (F28)", () => {
    const reviewStep = readRepoFile(
      "src/app/(authenticated)/book/_components/review-step.tsx",
    );
    expect(reviewStep).toContain('className="mb-2 text-sm font-medium text-foreground"');
    expect(reviewStep).toContain(
      'className="font-sans font-normal text-brand-charcoal"',
    );
    expect(reviewStep).not.toContain("dark:text-brand-gold");
  });

  it("hard-reloads the waitlist confirm success path so the CTA can't stick on Confirming (F28)", () => {
    const card = readRepoFile("src/components/waitlist-offer-card.tsx");
    // On success a full document reload re-renders the page from the server, so
    // the CTA can never stay stuck on "Confirming…" waiting on a soft refresh
    // that raced the re-render. No useRouter import means no soft router.refresh.
    expect(card).toContain("window.location.reload()");
    expect(card).not.toContain("useRouter");
  });

  it("hard-reloads the internet-banking switch success path so the IB card renders deterministically (F28)", () => {
    const button = readRepoFile(
      "src/components/switch-to-internet-banking-button.tsx",
    );
    // A fresh server render cannot show the pre-switch layout once payment.source
    // is INTERNET_BANKING, so a hard reload is deterministic where the soft
    // refresh raced (#1148). No useRouter import means no soft router.refresh.
    expect(button).toContain("window.location.reload()");
    expect(button).not.toContain("useRouter");
  });

  it("guards the public quote cancel behind a confirmation dialog (F28)", () => {
    const respondPage = readRepoFile(
      "src/app/(public)/booking-requests/respond/[token]/page.tsx",
    );
    expect(respondPage).toContain("useConfirm");
    expect(respondPage).toContain("cancelWithConfirmation");
    // The one-click destructive path must be gone.
    expect(respondPage).not.toContain('onClick={() => respond("CANCEL")}');
  });

  it("surfaces the booking status glossary and cancellation schedule to members (F28)", () => {
    const contextualHelp = readRepoFile("src/lib/contextual-help.ts");
    expect(contextualHelp).toContain("export const BOOKING_STATUS_GLOSSARY");
    // Admin help still renders the same shared glossary (no divergent copy).
    expect(contextualHelp).toContain("details: BOOKING_STATUS_GLOSSARY,");

    const helpDialog = readRepoFile("src/components/booking-help-dialog.tsx");
    expect(helpDialog).toContain("BOOKING_STATUS_GLOSSARY");
    expect(helpDialog).toContain("Cancellation refund schedule");
    // An unpaid-but-cancellable booking must not imply a refund it can't get
    // (owner review of PR #1389): say no payment received / no refund instead.
    expect(helpDialog).toContain(
      "No payment has been received for this booking, so no refund",
    );

    const bookingDetail = readRepoFile(
      "src/app/(authenticated)/bookings/[id]/page.tsx",
    );
    expect(bookingDetail).toContain("<BookingHelpDialog");
    expect(bookingDetail).toContain("describeCancellationSchedule");
    // The refund schedule is gated on a captured payment; unpaid bookings get the
    // no-refund message instead.
    expect(bookingDetail).toContain("originalPaymentCaptured");
    expect(bookingDetail).toContain("cancellationHasNoPayment");
  });

  it("removes the E2E ride-through allowances for the two fixed races (F28)", () => {
    // The components now hard-reload on success, so the specs assert the
    // freshly-rendered server state directly — no reload-retry ride-through loop
    // in the spec masking a soft-refresh race.
    const waitlistSpec = readRepoFile("e2e/waitlist.spec.ts");
    expect(waitlistSpec).not.toContain("assert the durable server state via reload");
    expect(waitlistSpec).not.toContain("await memberPage.reload()");
    expect(waitlistSpec).toContain("await expect(offerCard).toHaveCount(0, { timeout: 30_000 })");

    const ibSpec = readRepoFile("e2e/internet-banking.spec.ts");
    expect(ibSpec).not.toContain(
      "Assert the whole post-switch card atomically per",
    );
    expect(ibSpec).not.toContain("await page.reload()");
  });
});
