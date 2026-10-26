/**
 * #4199: every door that names guests reads a guest's `nights` through the one
 * request shape (`guestNightListSchema`, in `guestStayFieldsSchema`) and bounds
 * its guest lists by one of TWO shared limits, before anything reads the
 * database:
 *
 *  - a list of CHANGES (guests added, removed or renamed, and a new booking's
 *    party) by `BOOKING_REQUEST_GUESTS_MAX` (200), refused in the member's
 *    words (`GUEST_CHANGE_LIST_TOO_LONG_MESSAGE`);
 *  - a list that carries a live booking's WHOLE party (a grid or range-mode
 *    edit's stay ranges, the quote's and the promo preview's guests, the guest
 *    indexes and ids chosen from it) by `BOOKING_PARTY_GUESTS_MAX`, the most a
 *    lodge can be configured to hold, so a 210-guest booking at a big lodge can
 *    still be edited, quoted and previewed.
 *
 * A bad night is refused in the member's words (`GUEST_NIGHT_INVALID_MESSAGE`).
 * The edit exception door's cases live in its own route suite.
 *
 * The database is a stub that records that it was reached and then throws: a
 * refused request never reaches it, an accepted one always does. Frozen clock
 * discipline: fixed August 2026 lodge nights, after the 2026-07-01 freeze.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  BOOKING_PARTY_GUESTS_MAX,
  BOOKING_REQUEST_GUESTS_MAX,
  GUEST_CHANGE_LIST_TOO_LONG_MESSAGE,
  GUEST_NIGHT_INVALID_MESSAGE,
} from "@/lib/booking-guest-stay-range-input";
import { MAX_CONFIGURED_LODGE_CAPACITY } from "@/lib/lodge-effective-capacity";

const db = vi.hoisted(() => ({ reached: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        db.reached();
        throw new Error("the database was reached");
      },
    },
  ),
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } })),
}));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn(async () => null) }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: vi.fn().mockResolvedValue(null),
  checkRateLimit: vi.fn().mockResolvedValue({ success: true, resetAt: 0 }),
  getClientIp: vi.fn().mockReturnValue("0.0.0.0"),
  rateLimiters: { bookingCreate: {}, bookingQuery: {}, bookingChangeRequest: {} },
}));

import { POST as createPOST } from "@/app/api/bookings/route";
import { POST as quotePOST } from "@/app/api/bookings/quote/route";
import { POST as validatePOST } from "@/app/api/promo-codes/validate/route";
import { POST as newBookingExceptionPOST } from "@/app/api/bookings/exception-requests/route";
import { PUT as modifyPUT } from "@/app/api/bookings/[id]/modify/route";
import { modifyQuoteSchema } from "@/lib/booking-modify-quote-request";

beforeEach(() => {
  db.reached.mockClear();
});

const guest = { firstName: "Sam", lastName: "Guest", ageTier: "ADULT", isMember: false };
const many = <T,>(length: number, make: (index: number) => T) => Array.from({ length }, (_, index) => make(index));

/** Each door that takes a party as `guests`, with the bound its list carries. */
const doors = [
  { name: "create", post: createPOST, url: "http://localhost/api/bookings", extra: {}, fallback: "Invalid input", bound: "change" },
  { name: "quote", post: quotePOST, url: "http://localhost/api/bookings/quote", extra: {}, fallback: "Invalid input", bound: "party" },
  {
    name: "promo preview",
    post: validatePOST,
    url: "http://localhost/api/promo-codes/validate",
    extra: { code: "SAVE" },
    fallback: "Invalid input",
    bound: "party",
  },
  {
    name: "new-booking exception request",
    post: newBookingExceptionPOST,
    url: "http://localhost/api/bookings/exception-requests",
    extra: { memberMessage: "please" },
    fallback: "Validation failed",
    bound: "change",
  },
] as const;

/** POST to a door; a request the schema let through reaches the database stub and may throw. */
async function send(door: (typeof doors)[number], guests: unknown[], extra: Record<string, unknown> = {}) {
  const res = await door
    .post(
      new NextRequest(door.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkIn: "2026-08-10", checkOut: "2026-08-13", guests, ...door.extra, ...extra }),
      }),
    )
    .catch(() => null);
  return { status: res?.status ?? null, body: res ? await res.json() : null };
}

describe.each(doors)("$name: the shared night shape and guest bound (#4199)", (door) => {
  it("refuses a night that is not a date, in the member's words", async () => {
    const { status, body } = await send(door, [{ ...guest, nights: ["2026-08-10", "2026-13-45"] }]);
    expect(status).toBe(400);
    expect(body.error).toBe(GUEST_NIGHT_INVALID_MESSAGE);
    expect(body.details).toBeDefined();
    expect(db.reached).not.toHaveBeenCalled();
  });

  if (door.bound === "change") {
    it(`refuses more than ${BOOKING_REQUEST_GUESTS_MAX} guests for a new booking, in the member's words`, async () => {
      const { status, body } = await send(door, many(BOOKING_REQUEST_GUESTS_MAX + 1, () => guest));
      expect(status).toBe(400);
      expect(body.error).toBe(GUEST_CHANGE_LIST_TOO_LONG_MESSAGE);
      expect(db.reached).not.toHaveBeenCalled();
    });
  } else {
    it("takes a 210-guest booking's whole party past the schema", async () => {
      await send(door, many(210, () => guest));
      expect(db.reached).toHaveBeenCalled();
    });
  }
});

describe("the promo preview's guest indexes are chosen from the whole party", () => {
  it.each([
    ["the one-code guest choice", { promoGuestIndexes: many(210, (index) => index) }],
    ["a listed code's guest choice", { code: undefined, codes: [{ code: "SAVE", promoGuestIndexes: many(210, (index) => index) }] }],
  ])("takes 210 in %s past the schema", async (_label, extra) => {
    await send(doors[2], many(210, () => guest), extra);
    expect(db.reached).toHaveBeenCalled();
  });
});

/** The modify route, PUT as the booking's member. */
async function modify(body: Record<string, unknown>) {
  const res = await modifyPUT(
    new NextRequest("http://localhost/api/bookings/booking-1/modify", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "booking-1" }) },
  ).catch(() => null);
  return { status: res?.status ?? null, body: res ? await res.json() : null };
}

const tooManyChanges = <T,>(make: (index: number) => T) => many(BOOKING_REQUEST_GUESTS_MAX + 1, make);
const editRefusals: Array<[string, Record<string, unknown>, string]> = [
  [
    "a night that is not a date",
    { guestStayRanges: [{ guestId: "g1", nights: ["2026-08-10", "2026-13-45"] }] },
    GUEST_NIGHT_INVALID_MESSAGE,
  ],
  ["an added guest's night that is not a date", { addGuests: [{ ...guest, nights: ["not-a-night"] }] }, GUEST_NIGHT_INVALID_MESSAGE],
  ["201 added guests", { addGuests: tooManyChanges(() => guest) }, GUEST_CHANGE_LIST_TOO_LONG_MESSAGE],
  ["201 removed guests", { removeGuestIds: tooManyChanges((index) => `g${index}`) }, GUEST_CHANGE_LIST_TOO_LONG_MESSAGE],
  [
    "201 name corrections",
    { guestUpdates: tooManyChanges((index) => ({ guestId: `g${index}`, firstName: "Sam", lastName: "Guest" })) },
    GUEST_CHANGE_LIST_TOO_LONG_MESSAGE,
  ],
];

describe.each(editRefusals)("an edit refuses %s at the schema (#4199)", (_label, body, error) => {
  it("the modify route", async () => {
    const { status, body: answer } = await modify(body);
    expect(status).toBe(400);
    expect(answer.error).toBe(error);
    expect(db.reached).not.toHaveBeenCalled();
  });

  it("the modify quote", () => {
    const parsed = modifyQuoteSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues.map((issue) => issue.message)).toContain(error);
  });
});

describe("a 210-guest booking's grid edit is accepted (#4199, F1)", () => {
  // Grid mode sends every guest's nights, so a big booking's edit carries 210.
  const gridEdit = {
    guestStayRanges: many(210, (index) => ({ guestId: `g${index}`, nights: ["2026-08-10", "2026-08-12"] })),
    promoGuestIds: many(210, (index) => `g${index}`),
    otherLodgeMemberGuestIds: many(210, (index) => `g${index}`),
  };

  it("the modify route takes it past the schema", async () => {
    await modify(gridEdit);
    expect(db.reached).toHaveBeenCalled();
  });

  it("the modify quote's schema takes it", () => {
    expect(modifyQuoteSchema.safeParse(gridEdit).success).toBe(true);
  });

  it("exactly the change bound is accepted, one more is not", () => {
    expect(modifyQuoteSchema.safeParse({ removeGuestIds: many(BOOKING_REQUEST_GUESTS_MAX, (i) => `g${i}`) }).success).toBe(true);
    expect(modifyQuoteSchema.safeParse({ removeGuestIds: tooManyChanges((i) => `g${i}`) }).success).toBe(false);
  });
});

describe("the two bounds", () => {
  it("are the 200 create always had, and the most a lodge can be configured to hold", () => {
    expect(BOOKING_REQUEST_GUESTS_MAX).toBe(200);
    expect(BOOKING_PARTY_GUESTS_MAX).toBe(MAX_CONFIGURED_LODGE_CAPACITY);
    expect(GUEST_CHANGE_LIST_TOO_LONG_MESSAGE).toContain(String(BOOKING_REQUEST_GUESTS_MAX));
  });
});
