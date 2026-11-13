import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BookingStatus } from "@prisma/client";
import {
  WORK_PARTY_CORRECTABLE_BOOKING_STATUSES,
  workPartyBookingEligibility,
  type WorkPartyEligibilityBooking,
  type WorkPartyEligibilityEvent,
} from "@/lib/work-party-booking-correction";

/**
 * Fork #119: the eligibility rule for "Add booking to work party", one case per
 * refusal, and the census that keeps the officer-only internal-code admission
 * reachable from exactly one place. The money paths are proved on real
 * PostgreSQL in `work-party-booking-correction.realdb.test.ts`.
 */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const booking: WorkPartyEligibilityBooking = {
  status: BookingStatus.PAID,
  checkIn: d("2026-08-01"),
  checkOut: d("2026-08-04"),
  lodgeId: "lodge-1",
  hasWorkParty: false,
};

const event: WorkPartyEligibilityEvent = {
  name: "Spring Bee",
  active: true,
  startDate: d("2026-08-03"),
  endDate: d("2026-08-05"),
  lodgeId: "lodge-1",
  lodge: { name: "Main Lodge" },
  promoCode: { active: true, archivedAt: null },
};

describe("workPartyBookingEligibility", () => {
  it("accepts a current booking with a night inside an open work party at its lodge", () => {
    expect(workPartyBookingEligibility(booking, "lodge-1", event)).toEqual({ ok: true });
  });

  it("accepts a club-wide work party at any lodge", () => {
    expect(
      workPartyBookingEligibility(booking, "lodge-2", { ...event, lodgeId: null, lodge: null }),
    ).toEqual({ ok: true });
  });

  it.each([
    BookingStatus.CANCELLED,
    BookingStatus.COMPLETED,
    BookingStatus.DRAFT,
    BookingStatus.BUMPED,
    BookingStatus.WAITLISTED,
    BookingStatus.WAITLIST_OFFERED,
  ])("refuses a %s booking", (status) => {
    const result = workPartyBookingEligibility({ ...booking, status }, "lodge-1", event);
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/current booking/) });
  });

  it("allows exactly the live statuses", () => {
    expect([...WORK_PARTY_CORRECTABLE_BOOKING_STATUSES].sort()).toEqual(
      ["AWAITING_REVIEW", "CONFIRMED", "PAID", "PAYMENT_PENDING", "PENDING"].sort(),
    );
  });

  it.each([
    ["inactive", { active: false }],
    ["its promo inactive", { promoCode: { active: false, archivedAt: null } }],
    ["its promo archived", { promoCode: { active: true, archivedAt: d("2026-07-01") } }],
  ])("refuses a work party that is %s", (_label, change) => {
    expect(workPartyBookingEligibility(booking, "lodge-1", { ...event, ...change })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not active/),
    });
  });

  it("refuses a booking that already has a work party", () => {
    expect(
      workPartyBookingEligibility({ ...booking, hasWorkParty: true }, "lodge-1", event),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/already has a work party/) });
  });

  it("refuses a stay with no night inside the window (check-out is not a night)", () => {
    expect(
      workPartyBookingEligibility(
        { ...booking, checkIn: d("2026-07-30"), checkOut: d("2026-08-03") },
        "lodge-1",
        event,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/None of this booking/) });
  });

  it("refuses a booking at another lodge, naming the work party's", () => {
    expect(workPartyBookingEligibility(booking, "lodge-2", event)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/held at Main Lodge/),
    });
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("the officer-only internal-code admission (census)", () => {
  const root = path.join(process.cwd(), "src");
  const files = sourceFiles(root);
  const rel = (file: string) => path.relative(process.cwd(), file).replaceAll("\\", "/");

  it("walked the tree", () => {
    expect(files.length).toBeGreaterThan(500);
  });

  it("only work-party-booking-correction.ts passes `officerWorkPartyCorrection`", () => {
    const callers = files
      .filter((file) => readFileSync(file, "utf8").includes("officerWorkPartyCorrection:"))
      .map(rel)
      .sort();
    // The batch service declares it as `officerWorkPartyCorrection?:`; the
    // correction module is the one file that passes it.
    expect(callers).toEqual(["src/lib/work-party-booking-correction.ts"]);
  });

  it("is not a request-body field on any route", () => {
    const routes = files.filter((file) => file.endsWith(`${path.sep}route.ts`));
    const offenders = routes
      .filter((file) => /officerWorkParty/.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("still refuses every other internal code in applyPromoCodeChanges", () => {
    const plan = readFileSync(path.join(root, "lib", "booking-modify-plan.ts"), "utf8");
    expect(plan).toContain(
      "(promoCode.internal && promoCode.id !== officerWorkPartyPromoCodeId)",
    );
    // Defaulted to null, so a caller that passes nothing admits nothing.
    expect(plan).toContain("officerWorkPartyPromoCodeId = null,");
  });
});
