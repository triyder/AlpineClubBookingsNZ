import { describe, expect, it } from "vitest";
import { HutLeaderAssignmentSource } from "@prisma/client";
import { isCustodianOccupancy } from "@/lib/custodian-occupancy";
import {
  findHutLeaderStayRefusal,
  HUT_LEADER_NIGHTS_NOT_STAYED,
  isHutLeaderStayCheckExempt,
  loadHutLeaderStayedNightKeys,
  stayedNightRunContaining,
} from "@/lib/hut-leader-stayed-nights";
import { matchesWhere } from "@/lib/__tests__/support/prisma-where";

/**
 * The stay check behind the manual hut-leader create and edit (#3817, owner
 * decision "Block it outright"): a role-only assignment may claim only nights
 * the member is staying at that lodge.
 *
 * The double below is a small in-memory database that applies the filters the
 * check sends — lodge, status, the overlap bounds, consent and member — so a
 * cancelled stay or another lodge's stay is excluded by the QUERY, the same way
 * Postgres would exclude it, rather than by the fixture leaving it out.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Booking = {
  id: string;
  lodgeId: string;
  status: string;
  /** #3821: the school request it came from, when it is a school group's. */
  originBookingRequest?: { type: string } | null;
  /** #3821: the school request it is held for, while the quote is unaccepted. */
  heldForBookingRequest?: { type: string } | null;
  memberId: string | null;
  deletedAt?: Date | null;
  checkIn: Date;
  checkOut: Date;
  guests: Array<{
    memberId: string | null;
    consentStatus: string | null;
    stayStart: Date;
    stayEnd: Date;
    nights: Array<{ stayDate: Date }>;
  }>;
};

type BookingWhere = {
  deletedAt?: null;
  lodgeId: string;
  /** The status half: an operational stay or a school booking holding beds. */
  AND: unknown[];
  checkIn: { lte: Date };
  checkOut: { gt: Date };
  memberId?: string;
};

function bookingMatches(booking: Booking, where: BookingWhere) {
  return (
    (where.deletedAt === undefined || (booking.deletedAt ?? null) === null) &&
    booking.lodgeId === where.lodgeId &&
    // The status half evaluated as Postgres would (#3821), never re-derived.
    matchesWhere(
      {
        status: booking.status,
        originBookingRequest: booking.originBookingRequest ?? null,
        heldForBookingRequest: booking.heldForBookingRequest ?? null,
        adminCapacityHoldAt: null,
      },
      { AND: where.AND },
    ) &&
    booking.checkIn <= where.checkIn.lte &&
    booking.checkOut > where.checkOut.gt &&
    (where.memberId === undefined || booking.memberId === where.memberId)
  );
}

function fakeDb(bookings: Booking[]) {
  return {
    bookingGuest: {
      findMany: async (args: {
        where: {
          memberId: string;
          OR: Array<{ consentStatus: string | null }>;
          booking: BookingWhere;
        };
      }) =>
        bookings
          .filter((booking) => bookingMatches(booking, args.where.booking))
          .flatMap((booking) =>
            booking.guests
              .filter(
                (guest) =>
                  guest.memberId === args.where.memberId &&
                  args.where.OR.some((o) => o.consentStatus === guest.consentStatus),
              )
              .map((guest) => ({
                stayStart: guest.stayStart,
                stayEnd: guest.stayEnd,
                nights: guest.nights,
                booking: { checkIn: booking.checkIn, checkOut: booking.checkOut },
              })),
          ),
    },
    booking: {
      findMany: async (args: {
        where: BookingWhere;
        select: { guests: { where: { memberId: string } } };
      }) =>
        bookings
          .filter((booking) => bookingMatches(booking, args.where))
          .map((booking) => ({
            checkIn: booking.checkIn,
            checkOut: booking.checkOut,
            guests: booking.guests.filter(
              (guest) => guest.memberId === args.select.guests.where.memberId,
            ),
          })),
    },
  } as never;
}

/** A PAID booking at lodge-a with the member as its only guest. */
function stay(
  checkIn: string,
  checkOut: string,
  overrides: Partial<Booking> & { nights?: string[]; consentStatus?: string | null } = {},
): Booking {
  const { nights, consentStatus, ...rest } = overrides;
  return {
    id: `${checkIn}-${checkOut}`,
    lodgeId: "lodge-a",
    status: "PAID",
    memberId: "owner-x",
    checkIn: day(checkIn),
    checkOut: day(checkOut),
    guests: [
      {
        memberId: "member-1",
        consentStatus: consentStatus ?? null,
        stayStart: day(checkIn),
        stayEnd: day(checkOut),
        nights: (nights ?? []).map((n) => ({ stayDate: day(n) })),
      },
    ],
    ...rest,
  };
}

const ask = (db: never, startDate: string, endDate: string) =>
  findHutLeaderStayRefusal(db, {
    memberId: "member-1",
    lodgeId: "lodge-a",
    startDate: day(startDate),
    endDate: day(endDate),
  });

describe("findHutLeaderStayRefusal (#3817)", () => {
  // Arrive Mon 6 Jul, leave Wed 8 Jul: nights 6 and 7.
  const monToWed = stay("2026-07-06", "2026-07-08");

  it("accepts an assignment over exactly the nights stayed", async () => {
    expect(await ask(fakeDb([monToWed]), "2026-07-06", "2026-07-07")).toBeNull();
  });

  it("refuses the CHECK-OUT night, naming it and the last night stayed", async () => {
    const refusal = await ask(fakeDb([monToWed]), "2026-07-06", "2026-07-08");
    expect(refusal).toEqual(
      expect.objectContaining({
        code: HUT_LEADER_NIGHTS_NOT_STAYED,
        firstNightNotStayed: "2026-07-08",
        lastNightStayed: "2026-07-07",
      }),
    );
    expect(refusal?.error).toContain("2026-07-08");
    expect(refusal?.error).toContain("2026-07-07");
  });

  it("refuses a CANCELLED stay — a cancelled stay is not a stay", async () => {
    const cancelled = stay("2026-07-06", "2026-07-08", { status: "CANCELLED" });
    const refusal = await ask(fakeDb([cancelled]), "2026-07-06", "2026-07-07");
    expect(refusal).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-06", lastNightStayed: null }),
    );
  });

  it("counts a school booking that holds beds, awaiting its invoice (#3821, owner decision on #3820, 13 Oct 2026)", async () => {
    // "Yes, count it": an approved school booking is CONFIRMED until its
    // invoice is paid, and a member on it can lead its nights.
    const school = stay("2026-07-06", "2026-07-08", {
      status: "CONFIRMED",
      originBookingRequest: { type: "SCHOOL" },
    });
    expect(await ask(fakeDb([school]), "2026-07-06", "2026-07-07")).toBeNull();
  });

  it("refuses an unaccepted school quote's AWAITING_REVIEW hold — it holds beds but is not a stay (#3821)", async () => {
    // The owner's words: "a school booking that holds beds (CONFIRMED,
    // awaiting its invoice)". A quote the school has not accepted holds beds,
    // but its members get no hut-leader duty (and so no kiosk access) from it.
    const held = stay("2026-07-06", "2026-07-08", {
      status: "AWAITING_REVIEW",
      heldForBookingRequest: { type: "SCHOOL" },
    });
    expect(await ask(fakeDb([held]), "2026-07-06", "2026-07-07")).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-06" }),
    );
  });

  it("refuses a converted school quote still PENDING — only CONFIRMED counts (#3821)", async () => {
    const pending = stay("2026-07-06", "2026-07-08", {
      status: "PENDING",
      originBookingRequest: { type: "SCHOOL" },
    });
    expect(await ask(fakeDb([pending]), "2026-07-06", "2026-07-07")).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-06" }),
    );
  });

  it("still refuses a CONFIRMED booking that is not a school group's", async () => {
    const general = stay("2026-07-06", "2026-07-08", {
      status: "CONFIRMED",
      originBookingRequest: { type: "GENERAL" },
    });
    expect(await ask(fakeDb([general]), "2026-07-06", "2026-07-07")).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-06" }),
    );
  });

  it("counts a COMPLETED stay (a past assignment edited after the stay)", async () => {
    const completed = stay("2026-07-06", "2026-07-08", { status: "COMPLETED" });
    expect(await ask(fakeDb([completed]), "2026-07-06", "2026-07-07")).toBeNull();
  });

  it("refuses a SOFT-DELETED stay, whatever its status", async () => {
    const deleted = stay("2026-07-06", "2026-07-08", { deletedAt: day("2026-07-01") });
    expect(await ask(fakeDb([deleted]), "2026-07-06", "2026-07-07")).not.toBeNull();
  });

  it("refuses a stay at ANOTHER lodge", async () => {
    const elsewhere = stay("2026-07-06", "2026-07-08", { lodgeId: "lodge-b" });
    expect(await ask(fakeDb([elsewhere]), "2026-07-06", "2026-07-07")).not.toBeNull();
  });

  it("refuses a guest row whose consent is still pending (D-12)", async () => {
    const pending = stay("2026-07-06", "2026-07-08", { consentStatus: "PENDING" });
    expect(await ask(fakeDb([pending]), "2026-07-06", "2026-07-07")).not.toBeNull();
  });

  it("refuses a split stay's GAP night and offers the end of the first run", async () => {
    // Nights 6, 7 and 9: the envelope 6-10 fills the 8th, the night set does not.
    const split = stay("2026-07-06", "2026-07-10", {
      nights: ["2026-07-06", "2026-07-07", "2026-07-09"],
    });
    const refusal = await ask(fakeDb([split]), "2026-07-06", "2026-07-09");
    expect(refusal).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-08", lastNightStayed: "2026-07-07" }),
    );
  });

  it("does NOT count a booking the member OWNS but is not a guest on (owner decision, 3 Oct)", async () => {
    // The fake still answers `booking.findMany` with the owned booking, so a
    // reintroduced owner arm would count it and this test would fail.
    const owned: Booking = { ...stay("2026-07-06", "2026-07-08"), memberId: "member-1", guests: [] };
    expect(await ask(fakeDb([owned]), "2026-07-06", "2026-07-07")).toEqual(
      expect.objectContaining({ firstNightNotStayed: "2026-07-06", lastNightStayed: null }),
    );
  });

  it("counts an owner who IS a guest on their own booking, through the guest row", async () => {
    const ownedAndOn: Booking = { ...stay("2026-07-06", "2026-07-08"), memberId: "member-1" };
    expect(await ask(fakeDb([ownedAndOn]), "2026-07-06", "2026-07-07")).toBeNull();
  });

  it("names the custodian way out in every refusal", async () => {
    const refusal = await ask(fakeDb([monToWed]), "2026-07-06", "2026-07-08");
    expect(refusal?.error).toContain("mark them Custodian (lives on site)");
  });

  it("joins two back-to-back stays into one run", async () => {
    const first = stay("2026-07-06", "2026-07-08");
    const second = stay("2026-07-08", "2026-07-10");
    expect(await ask(fakeDb([first, second]), "2026-07-06", "2026-07-09")).toBeNull();
  });

  it("Wednesday-leave / Thursday-arrive: neither leader may claim Wednesday night", async () => {
    // Leader A leaves Wed 8 Jul (last night Tue 7th); leader B arrives Thu 9th.
    const leaverRefusal = await ask(fakeDb([monToWed]), "2026-07-06", "2026-07-08");
    expect(leaverRefusal?.firstNightNotStayed).toBe("2026-07-08");
    const arriver = stay("2026-07-09", "2026-07-11");
    const arriverRefusal = await ask(fakeDb([arriver]), "2026-07-08", "2026-07-10");
    expect(arriverRefusal?.firstNightNotStayed).toBe("2026-07-08");
    // The arriver's start night is not stayed, so no corrected end is offered.
    expect(arriverRefusal?.lastNightStayed).toBeNull();
  });
});

describe("loadHutLeaderStayedNightKeys", () => {
  it("clips to the asked range and never returns a check-out morning", async () => {
    const keys = await loadHutLeaderStayedNightKeys(fakeDb([stay("2026-07-06", "2026-07-10")]), {
      memberId: "member-1",
      lodgeId: "lodge-a",
      rangeStart: day("2026-07-07"),
      rangeEnd: day("2026-07-12"),
    });
    expect(keys).toEqual(["2026-07-07", "2026-07-08", "2026-07-09"]);
  });
});

describe("stayedNightRunContaining", () => {
  it("returns the consecutive run around a night, or null for an unstayed one", () => {
    const nights = ["2026-07-06", "2026-07-07", "2026-07-09", "2026-07-10"];
    expect(stayedNightRunContaining(nights, "2026-07-07")).toEqual({
      first: "2026-07-06",
      last: "2026-07-07",
    });
    expect(stayedNightRunContaining(nights, "2026-07-10")).toEqual({
      first: "2026-07-09",
      last: "2026-07-10",
    });
    expect(stayedNightRunContaining(nights, "2026-07-08")).toBeNull();
  });
});

describe("isHutLeaderStayCheckExempt (#3817)", () => {
  const MANUAL = HutLeaderAssignmentSource.MANUAL;
  it("exempts a held bed, the custodian tick or a school teacher's row, and nothing else", () => {
    expect(isHutLeaderStayCheckExempt({ bedId: "bed-1", isCustodian: false, source: MANUAL })).toBe(true);
    expect(isHutLeaderStayCheckExempt({ bedId: null, isCustodian: true, source: MANUAL })).toBe(true);
    expect(isHutLeaderStayCheckExempt({ bedId: "bed-1", isCustodian: true, source: MANUAL })).toBe(true);
    expect(isHutLeaderStayCheckExempt({ bedId: null, isCustodian: false, source: MANUAL })).toBe(false);
    expect(
      isHutLeaderStayCheckExempt({
        bedId: null,
        isCustodian: false,
        source: HutLeaderAssignmentSource.SCHOOL_BOOKING,
      }),
    ).toBe(true);
  });

  it("is the custodian-occupancy predicate plus the school carve-out", () => {
    for (const bedId of ["bed-1", null, undefined]) {
      for (const isCustodian of [true, false, null, undefined]) {
        expect(isHutLeaderStayCheckExempt({ bedId, isCustodian, source: MANUAL })).toBe(
          isCustodianOccupancy({ bedId, isCustodian }),
        );
      }
    }
  });
});
