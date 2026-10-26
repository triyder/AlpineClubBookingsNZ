/**
 * Real-PostgreSQL proofs for shared DOUBLE beds through the lifecycle
 * auto-allocator (#2656). Ordinary Vitest runs skip these; the explicit
 * concurrency job imports this file from
 * `concurrency-lock-races.realdb.test.ts` after migrating a disposable,
 * loopback-only database.
 *
 * Why a real database rather than the mocked lifecycle suite: the two dangerous
 * outcomes are both properties of the WRITE, and both depend on real indexes.
 * When a plan targets a bed-night whose surviving occupant is the PRIMARY,
 * `@@unique([bedId, stayDate, isSecondOccupant])` swallows the row and
 * `createMany({ skipDuplicates: true })` reports success — the guest-night
 * neither placed nor reported. When the survivor is the SECOND occupant there
 * is no collision at all, and the row is simply created: an unrelated person in
 * a double beside somebody else's partner, with no `MemberPartnerLink`. A mock
 * cannot establish either, because neither is a property of the mock.
 */
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const RACE_DB_URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";

const ACTOR_ID = "sd-2656-admin";
const LODGE_ID = "sd-2656-lodge";
const ROOM_ID = "sd-2656-room";
const DOUBLE_BED_ID = "sd-2656-double";
const SINGLE_BED_ID = "sd-2656-single";

const HELD_BOOKING_ID = "sd-2656-held";
const HELD_GUEST_ID = "sd-2656-held-guest";
const PINNED_BOOKING_ID = "sd-2656-pinned";
const PINNED_GUEST_ID = "sd-2656-pinned-guest";
const PROVISIONAL_BOOKING_ID = "sd-2656-provisional";
const PROVISIONAL_GUEST_ID = "sd-2656-provisional-guest";
// A guest holds at most one bed per night (@@unique([bookingGuestId, stayDate])),
// so the provisional booking needs a SECOND guest to hold the second bed.
const PROVISIONAL_GUEST_2_ID = "sd-2656-provisional-guest-2";

const FIXTURE_BOOKING_IDS = [
  HELD_BOOKING_ID,
  PINNED_BOOKING_ID,
  PROVISIONAL_BOOKING_ID,
];

const NIGHT = new Date("2099-05-01T00:00:00.000Z");
const CHECK_OUT = new Date("2099-05-02T00:00:00.000Z");

let prisma: typeof import("@/lib/prisma")["prisma"];
let reconcileBedAllocationsForBooking: typeof import("@/lib/bed-allocation-lifecycle")["reconcileBedAllocationsForBooking"];

let moduleSettingsExisted = false;
let previousBedAllocationModuleEnabled: boolean | null = null;

async function clearFixtures(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { memberId: ACTOR_ID },
        { actorMemberId: ACTOR_ID },
        { targetId: { in: FIXTURE_BOOKING_IDS } },
      ],
    },
  });
  await prisma.bookingEvent.deleteMany({
    where: { bookingId: { in: FIXTURE_BOOKING_IDS } },
  });
  await prisma.booking.deleteMany({ where: { id: { in: FIXTURE_BOOKING_IDS } } });
}

async function seedBooking(input: {
  bookingId: string;
  guestId: string;
  status: "PAID" | "PENDING";
  extraGuestId?: string;
}): Promise<void> {
  await prisma.booking.create({
    data: {
      id: input.bookingId,
      memberId: ACTOR_ID,
      lodgeId: LODGE_ID,
      checkIn: NIGHT,
      checkOut: CHECK_OUT,
      status: input.status,
      totalPriceCents: 100,
      finalPriceCents: 100,
    },
  });
  await prisma.bookingGuest.create({
    data: {
      id: input.guestId,
      bookingId: input.bookingId,
      firstName: "Shared",
      lastName: "Double",
      ageTier: "ADULT",
      stayStart: NIGHT,
      stayEnd: CHECK_OUT,
      priceCents: 100,
    },
  });
  await prisma.bookingGuestNight.create({
    data: { bookingGuestId: input.guestId, stayDate: NIGHT, priceCents: 100 },
  });
  if (input.extraGuestId) {
    await prisma.bookingGuest.create({
      data: {
        id: input.extraGuestId,
        bookingId: input.bookingId,
        firstName: "Shared",
        lastName: "Double Two",
        ageTier: "ADULT",
        stayStart: NIGHT,
        stayEnd: CHECK_OUT,
        priceCents: 100,
      },
    });
    await prisma.bookingGuestNight.create({
      data: {
        bookingGuestId: input.extraGuestId,
        stayDate: NIGHT,
        priceCents: 100,
      },
    });
  }
}

async function allocationsOnBed(bedId: string) {
  return prisma.bedAllocation.findMany({
    where: { bedId, stayDate: NIGHT },
    select: { bookingId: true, bookingGuestId: true, isSecondOccupant: true },
    orderBy: [{ isSecondOccupant: "asc" }, { bookingGuestId: "asc" }],
  });
}

if (RUN) {
  describe("shared double beds through the lifecycle auto-allocator (#2656)", () => {
    beforeAll(async () => {
      assertSafeRaceDbUrl(RACE_DB_URL, "bed-allocation shared-double"); // #4142: the one shared guard (INV-SSOT-001)
      process.env.DATABASE_URL = RACE_DB_URL;
      ({ prisma } = await import("@/lib/prisma"));
      ({ reconcileBedAllocationsForBooking } = await import(
        "@/lib/bed-allocation-lifecycle"
      ));

      const priorModuleSettings = await prisma.clubModuleSettings.findUnique({
        where: { id: "default" },
        select: { bedAllocation: true },
      });
      moduleSettingsExisted = priorModuleSettings !== null;
      previousBedAllocationModuleEnabled =
        priorModuleSettings?.bedAllocation ?? null;
      await prisma.clubModuleSettings.upsert({
        where: { id: "default" },
        create: { id: "default", bedAllocation: true },
        update: { bedAllocation: true },
        select: { id: true },
      });

      await clearFixtures();
      await prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodgeBed.deleteMany({
        where: { id: { in: [DOUBLE_BED_ID, SINGLE_BED_ID] } },
      });
      await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: ACTOR_ID } });

      await prisma.member.create({
        data: {
          id: ACTOR_ID,
          email: "sd-2656@example.invalid",
          passwordHash: "not-a-real-password",
          firstName: "Shared",
          lastName: "Double",
          role: "ADMIN",
          ageTier: "ADULT",
        },
      });
      await prisma.lodge.create({
        data: { id: LODGE_ID, name: "Shared Double Lodge", slug: "sd-2656" },
      });
      await prisma.lodgeRoom.create({
        data: { id: ROOM_ID, lodgeId: LODGE_ID, name: "Shared Double Room" },
      });
      await prisma.lodgeBed.createMany({
        data: [
          {
            id: DOUBLE_BED_ID,
            roomId: ROOM_ID,
            name: "Double",
            bedType: "DOUBLE",
            sortOrder: 0,
          },
          {
            id: SINGLE_BED_ID,
            roomId: ROOM_ID,
            name: "Single",
            bedType: "SINGLE",
            sortOrder: 1,
          },
        ],
      });
      await prisma.bedAllocationSettings.create({
        data: {
          id: LODGE_ID,
          lodgeId: LODGE_ID,
          autoAllocationEnabled: true,
          allocationPriorityOrder: [
            "BOOKING_COHESION",
            "STAY_CONTINUITY",
            "REQUESTED_ROOM",
            "FAMILY_COHESION",
          ],
          updatedByMemberId: ACTOR_ID,
        },
      });
    }, 60_000);

    beforeEach(async () => {
      await clearFixtures();
    });

    afterEach(async () => {
      await clearFixtures();
    });

    afterAll(async () => {
      await clearFixtures();
      await prisma.bedAllocationSettings.deleteMany({ where: { id: LODGE_ID } });
      await prisma.lodgeBed.deleteMany({
        where: { id: { in: [DOUBLE_BED_ID, SINGLE_BED_ID] } },
      });
      await prisma.lodgeRoom.deleteMany({ where: { id: ROOM_ID } });
      await prisma.lodge.deleteMany({ where: { id: LODGE_ID } });
      await prisma.member.deleteMany({ where: { id: ACTOR_ID } });
      if (moduleSettingsExisted && previousBedAllocationModuleEnabled !== null) {
        await prisma.clubModuleSettings.update({
          where: { id: "default" },
          data: { bedAllocation: previousBedAllocationModuleEnabled },
          select: { id: true },
        });
      } else if (!moduleSettingsExisted) {
        await prisma.clubModuleSettings.deleteMany({ where: { id: "default" } });
      }
    });

    it("never seats a held booking on a double whose other occupant survives", async () => {
      // The double holds a capacity-holding PRIMARY and a provisional SECOND
      // occupant; the provisional booking's other guest holds the single, so
      // NOTHING is free when a held booking arrives needing a bed.
      //
      // Displacing the provisional booking whole frees the single and NOT the
      // double, because the capacity-holding primary is still in it. Before
      // #2656 the planner released the whole bed-night and drafted a row onto
      // the double: against the real index that row is swallowed by
      // @@unique([bedId, stayDate, isSecondOccupant]) and reported as written —
      // a booking displaced and audited for a guest-night that was neither
      // placed nor reported as unplaceable.
      await seedBooking({
        bookingId: PINNED_BOOKING_ID,
        guestId: PINNED_GUEST_ID,
        status: "PAID",
      });
      await seedBooking({
        bookingId: PROVISIONAL_BOOKING_ID,
        guestId: PROVISIONAL_GUEST_ID,
        status: "PENDING",
        extraGuestId: PROVISIONAL_GUEST_2_ID,
      });
      await seedBooking({
        bookingId: HELD_BOOKING_ID,
        guestId: HELD_GUEST_ID,
        status: "PAID",
      });
      await prisma.bedAllocation.createMany({
        data: [
          {
            bookingId: PINNED_BOOKING_ID,
            bookingGuestId: PINNED_GUEST_ID,
            roomId: ROOM_ID,
            bedId: DOUBLE_BED_ID,
            bedType: "DOUBLE",
            stayDate: NIGHT,
            source: "MANUAL",
          },
          {
            bookingId: PROVISIONAL_BOOKING_ID,
            bookingGuestId: PROVISIONAL_GUEST_ID,
            roomId: ROOM_ID,
            bedId: DOUBLE_BED_ID,
            bedType: "DOUBLE",
            stayDate: NIGHT,
            source: "MANUAL",
            isSecondOccupant: true,
          },
          {
            bookingId: PROVISIONAL_BOOKING_ID,
            bookingGuestId: PROVISIONAL_GUEST_2_ID,
            roomId: ROOM_ID,
            bedId: SINGLE_BED_ID,
            stayDate: NIGHT,
            source: "MANUAL",
          },
        ],
      });

      await reconcileBedAllocationsForBooking({ bookingId: HELD_BOOKING_ID });

      // The pinned primary is untouched and the held booking is nowhere near
      // the double — whether or not the provisional second occupant went with
      // its displaced booking.
      const onDouble = await allocationsOnBed(DOUBLE_BED_ID);
      expect(onDouble[0]).toEqual({
        bookingId: PINNED_BOOKING_ID,
        bookingGuestId: PINNED_GUEST_ID,
        isSecondOccupant: false,
      });
      expect(
        onDouble.some((row) => row.bookingId === HELD_BOOKING_ID),
      ).toBe(false);
      // The single bed is genuinely free, so the held guest takes THAT.
      expect(await allocationsOnBed(SINGLE_BED_ID)).toEqual([
        {
          bookingId: HELD_BOOKING_ID,
          bookingGuestId: HELD_GUEST_ID,
          isSecondOccupant: false,
        },
      ]);
    });

    it("never writes a stranger in beside a surviving SECOND occupant", async () => {
      // The dangerous half. Here the survivor is the second occupant, so a row
      // drafted onto the double collides with NOTHING — `skipDuplicates` has no
      // duplicate to skip and the write goes through, putting an unrelated
      // booking's guest into a double with someone else's partner and no
      // MemberPartnerLink. Only the plan and the write-time occupancy guard
      // stand between the lodge and that row.
      await seedBooking({
        bookingId: PROVISIONAL_BOOKING_ID,
        guestId: PROVISIONAL_GUEST_ID,
        status: "PENDING",
        extraGuestId: PROVISIONAL_GUEST_2_ID,
      });
      await seedBooking({
        bookingId: PINNED_BOOKING_ID,
        guestId: PINNED_GUEST_ID,
        status: "PAID",
      });
      await seedBooking({
        bookingId: HELD_BOOKING_ID,
        guestId: HELD_GUEST_ID,
        status: "PAID",
      });
      await prisma.bedAllocation.createMany({
        data: [
          {
            bookingId: PROVISIONAL_BOOKING_ID,
            bookingGuestId: PROVISIONAL_GUEST_ID,
            roomId: ROOM_ID,
            bedId: DOUBLE_BED_ID,
            bedType: "DOUBLE",
            stayDate: NIGHT,
            source: "MANUAL",
          },
          {
            bookingId: PINNED_BOOKING_ID,
            bookingGuestId: PINNED_GUEST_ID,
            roomId: ROOM_ID,
            bedId: DOUBLE_BED_ID,
            bedType: "DOUBLE",
            stayDate: NIGHT,
            source: "MANUAL",
            isSecondOccupant: true,
          },
          {
            bookingId: PROVISIONAL_BOOKING_ID,
            bookingGuestId: PROVISIONAL_GUEST_2_ID,
            roomId: ROOM_ID,
            bedId: SINGLE_BED_ID,
            stayDate: NIGHT,
            source: "MANUAL",
          },
        ],
      });

      await reconcileBedAllocationsForBooking({ bookingId: HELD_BOOKING_ID });

      const onDouble = await allocationsOnBed(DOUBLE_BED_ID);
      // Whatever else happened, no third party is in the double.
      expect(
        onDouble.every((row) => row.bookingId !== HELD_BOOKING_ID),
      ).toBe(true);
      // The pinned partner is still there and is never left as an orphaned
      // second occupant: if the displacement took the primary with it, the
      // survivor was promoted.
      const pinned = onDouble.find(
        (row) => row.bookingGuestId === PINNED_GUEST_ID,
      );
      expect(pinned).toBeDefined();
      if (onDouble.length === 1) {
        expect(pinned?.isSecondOccupant).toBe(false);
      }
    });

    it("promotes the surviving partner when a displacement removes the double's primary", async () => {
      // The provisional booking holds the PRIMARY slot of the double and also
      // the single bed. Displacing it whole takes the primary away and leaves
      // the pinned partner behind — the orphan every other removal path in the
      // codebase repairs, and this one did not until #2656.
      await seedBooking({
        bookingId: PROVISIONAL_BOOKING_ID,
        guestId: PROVISIONAL_GUEST_ID,
        status: "PENDING",
        extraGuestId: PROVISIONAL_GUEST_2_ID,
      });
      await seedBooking({
        bookingId: PINNED_BOOKING_ID,
        guestId: PINNED_GUEST_ID,
        status: "PAID",
      });
      await seedBooking({
        bookingId: HELD_BOOKING_ID,
        guestId: HELD_GUEST_ID,
        status: "PAID",
      });
      await prisma.bedAllocation.createMany({
        data: [
          {
            bookingId: PROVISIONAL_BOOKING_ID,
            bookingGuestId: PROVISIONAL_GUEST_ID,
            roomId: ROOM_ID,
            bedId: DOUBLE_BED_ID,
            bedType: "DOUBLE",
            stayDate: NIGHT,
            source: "MANUAL",
          },
          {
            bookingId: PINNED_BOOKING_ID,
            bookingGuestId: PINNED_GUEST_ID,
            roomId: ROOM_ID,
            bedId: DOUBLE_BED_ID,
            bedType: "DOUBLE",
            stayDate: NIGHT,
            source: "MANUAL",
            isSecondOccupant: true,
          },
          // The provisional booking also holds the only other bed, so the held
          // booking cannot be seated without displacing it.
          {
            bookingId: PROVISIONAL_BOOKING_ID,
            bookingGuestId: PROVISIONAL_GUEST_2_ID,
            roomId: ROOM_ID,
            bedId: SINGLE_BED_ID,
            stayDate: NIGHT,
            source: "MANUAL",
          },
        ],
      });

      await reconcileBedAllocationsForBooking({ bookingId: HELD_BOOKING_ID });

      // The primary left with its booking; the partner it would have stranded
      // is now the primary, so the bed-night is not dead-ended behind the
      // orphaned-second-occupant guard in resolveSecondOccupant.
      expect(await allocationsOnBed(DOUBLE_BED_ID)).toEqual([
        {
          bookingId: PINNED_BOOKING_ID,
          bookingGuestId: PINNED_GUEST_ID,
          isSecondOccupant: false,
        },
      ]);
      // The held guest takes the bed the displacement genuinely freed.
      expect(await allocationsOnBed(SINGLE_BED_ID)).toEqual([
        {
          bookingId: HELD_BOOKING_ID,
          bookingGuestId: HELD_GUEST_ID,
          isSecondOccupant: false,
        },
      ]);
      // The promotion is audited against the PARTNER's own booking, which is
      // not the booking whose displacement caused it.
      const promotionAudits = await prisma.auditLog.findMany({
        where: { action: "BED_ALLOCATION_PARTNER_PROMOTED" },
        select: { targetId: true },
      });
      expect(promotionAudits).toEqual([{ targetId: PINNED_BOOKING_ID }]);
    });
  });
} else {
  describe.skip("shared double beds through the lifecycle auto-allocator (#2656)", () => {
    it("is skipped without RUN_CONCURRENCY_RACE_TESTS=1", () => {
      expect(RUN).toBe(false);
    });
  });
}
