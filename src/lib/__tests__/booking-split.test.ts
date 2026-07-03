/**
 * Split-booking tests (issue #738).
 *
 * A mixed member/non-member party that is not flagged becomes two linked
 * bookings: a member booking charged up front (PAYMENT_PENDING, holds capacity)
 * and a provisional non-member child booking (PENDING, holds nothing,
 * parentBookingId = the member booking). Pure parties stay a single booking.
 * The flagged "only book if my guests can come" path is a single provisional
 * PENDING booking holding nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BookingStatus, AgeTier } from "@prisma/client";

const h = vi.hoisted(() => ({
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  seasonFindMany: vi.fn(),
  bookingCreate: vi.fn(),
  bookingUpdate: vi.fn(),
  paymentCreate: vi.fn(),
  memberFindUnique: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
  reconcileBedAllocationsForBooking: vi.fn(),
  logAudit: vi.fn(),
  groupJoinFindUnique: vi.fn(),
  groupJoinCreate: vi.fn(),
  groupJoinUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => h.transaction(fn),
    member: { findUnique: (...a: unknown[]) => h.memberFindUnique(...a) },
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: (...a: unknown[]) => h.checkCapacityForGuestRanges(...a),
}));

vi.mock("@/lib/policies/booking-route-decisions", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/policies/booking-route-decisions")>();
  return {
    ...actual,
    // Deterministic $50/guest pricing so member/child bookings price above $0
    // (keeps them off the zero-dollar auto-PAID path).
    priceBookingGuests: (input: { guests: unknown[] }) => ({
      totalPriceCents: input.guests.length * 5000,
      guests: input.guests.map(() => ({ priceCents: 5000, perNightCents: [5000] })),
    }),
  };
});

vi.mock("@/lib/promo", () => ({
  redeemPromoCode: vi.fn(),
  shouldPersistPromoRedemption: vi.fn().mockReturnValue(false),
  validateAndCalculatePromoDiscount: vi.fn(),
}));

vi.mock("@/lib/work-party", () => ({
  resolveWorkPartyEventPromoForBooking: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendAdminNewBookingAlert: vi.fn().mockResolvedValue(undefined),
  sendBookingConfirmedEmail: vi.fn().mockResolvedValue(undefined),
  sendBookingPendingEmail: vi.fn().mockResolvedValue(undefined),
  sendWaitlistConfirmationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: vi.fn().mockResolvedValue({ queueOperationId: null }),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/member-credit", () => ({
  applyCreditToBooking: vi.fn(),
  getMemberCreditBalance: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/payment-transactions", () => ({
  recordInternetBankingPaymentTransaction: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => h.logAudit(...a) }));

vi.mock("@/lib/booking-review", () => ({
  ADULT_SUPERVISION_REVIEW_REASON: "no-adult",
  requiresAdultSupervisionReview: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: (...a: unknown[]) => h.reconcileBedAllocationsForBooking(...a),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createConfirmedBooking,
  GroupJoinConflictError,
  type BookingGuestInput,
} from "@/lib/booking-create";

const checkIn = new Date("2026-09-10T00:00:00.000Z");
const checkOut = new Date("2026-09-12T00:00:00.000Z");
const mockSeasons = [
  {
    id: "season-1",
    startDate: new Date("2026-09-01T00:00:00.000Z"),
    endDate: new Date("2026-09-30T00:00:00.000Z"),
    rates: [
      {
        ageTier: AgeTier.ADULT,
        isMember: true,
        pricePerNightCents: 2500,
      },
      {
        ageTier: AgeTier.ADULT,
        isMember: false,
        pricePerNightCents: 5000,
      },
    ],
  },
];

let createdCount = 0;
const tx = {
  $executeRaw: (...a: unknown[]) => h.executeRaw(...a),
  season: { findMany: (...a: unknown[]) => h.seasonFindMany(...a) },
  booking: {
    create: (...a: unknown[]) => h.bookingCreate(...a),
    update: (...a: unknown[]) => h.bookingUpdate(...a),
  },
  payment: { create: (...a: unknown[]) => h.paymentCreate(...a) },
  groupBookingJoin: {
    findUnique: (...a: unknown[]) => h.groupJoinFindUnique(...a),
    create: (...a: unknown[]) => h.groupJoinCreate(...a),
    update: (...a: unknown[]) => h.groupJoinUpdate(...a),
  },
};

function guest(isMember: boolean, firstName: string): BookingGuestInput {
  return {
    firstName,
    lastName: "Test",
    ageTier: AgeTier.ADULT,
    isMember,
    stayStart: checkIn,
    stayEnd: checkOut,
  };
}

function baseInput(
  guests: BookingGuestInput[],
  overrides: Partial<Parameters<typeof createConfirmedBooking>[0]> = {}
) {
  const hasNonMembers = guests.some((g) => !g.isMember);
  return {
    effectiveMemberId: "member-1",
    isOnBehalf: false,
    sessionUserId: "member-1",
    checkIn,
    checkOut,
    guests,
    status: hasNonMembers ? BookingStatus.PENDING : BookingStatus.PAYMENT_PENDING,
    shouldBePending: hasNonMembers,
    holdDays: 7,
    ...overrides,
  };
}

/** The `data` payload of each tx.booking.create call, in order. */
function createPayloads() {
  return h.bookingCreate.mock.calls.map((call) => (call[0] as { data: Record<string, unknown> }).data);
}

describe("createConfirmedBooking split bookings (#738)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdCount = 0;
    h.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx));
    h.executeRaw.mockResolvedValue(undefined);
    h.seasonFindMany.mockResolvedValue(mockSeasons);
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, nightDetails: [] });
    h.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    h.bookingUpdate.mockResolvedValue({});
    h.memberFindUnique.mockResolvedValue({ id: "member-1", firstName: "Mem", lastName: "Ber", email: "m@example.com" });
    h.bookingCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
      createdCount += 1;
      const id = `booking-${createdCount}`;
      const guestRows = (args.data.guests as { create: Array<Record<string, unknown>> }).create.map(
        (g, i) => ({ ...g, id: `${id}-g${i}` })
      );
      return Promise.resolve({ ...args.data, id, guests: guestRows });
    });
  });

  it("splits a mixed party into a member booking (held) and a provisional non-member child", async () => {
    const guests = [guest(true, "Alice"), guest(false, "Bob")];
    const outcome = await createConfirmedBooking(baseInput(guests));

    expect(outcome.type).toBe("created");
    const payloads = createPayloads();
    expect(payloads).toHaveLength(2);

    // Primary = member booking: charged up front, holds capacity, no children.
    const [primary, child] = payloads;
    expect(primary.status).toBe(BookingStatus.PAYMENT_PENDING);
    expect(primary.hasNonMembers).toBe(false);
    expect(primary.parentBookingId).toBeUndefined();
    expect((primary.guests as { create: unknown[] }).create).toHaveLength(1);
    expect(primary.nonMemberHoldUntil).toBeNull();

    // Child = provisional non-member booking: PENDING, holds nothing, linked.
    expect(child.status).toBe(BookingStatus.PENDING);
    expect(child.hasNonMembers).toBe(true);
    expect(child.parentBookingId).toBe("booking-1");
    expect((child.guests as { create: Array<{ isMember: boolean }> }).create).toHaveLength(1);
    expect((child.guests as { create: Array<{ isMember: boolean }> }).create[0].isMember).toBe(false);
    expect(child.nonMemberHoldUntil).toBeInstanceOf(Date);

    // The returned booking is the member (primary) booking, so the booker is
    // sent to pay for the held portion.
    if (outcome.type === "created") {
      expect(outcome.booking.id).toBe("booking-1");
    }
  });

  it("keeps a pure-member party as a single held booking", async () => {
    const guests = [guest(true, "Alice"), guest(true, "Carol")];
    await createConfirmedBooking(baseInput(guests));

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].status).toBe(BookingStatus.PAYMENT_PENDING);
    expect(payloads[0].hasNonMembers).toBe(false);
    expect(payloads[0].parentBookingId).toBeUndefined();
  });

  it("keeps a pure-non-member party as a single provisional booking", async () => {
    const guests = [guest(false, "Bob"), guest(false, "Dan")];
    await createConfirmedBooking(baseInput(guests));

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].status).toBe(BookingStatus.PENDING);
    expect(payloads[0].hasNonMembers).toBe(true);
    expect(payloads[0].parentBookingId).toBeUndefined();
  });

  it("keeps a flagged mixed party as one provisional booking holding nothing", async () => {
    const guests = [guest(true, "Alice"), guest(false, "Bob")];
    await createConfirmedBooking(baseInput(guests, { cancelIfGuestsBumped: true }));

    const payloads = createPayloads();
    expect(payloads).toHaveLength(1);
    // The whole party (members included) is a single provisional PENDING hold,
    // nothing charged up front.
    expect(payloads[0].status).toBe(BookingStatus.PENDING);
    expect(payloads[0].hasNonMembers).toBe(true);
    expect(payloads[0].parentBookingId).toBeUndefined();
    expect((payloads[0].guests as { create: unknown[] }).create).toHaveLength(2);
    // No up-front payment is taken for the flagged provisional booking.
    expect(h.paymentCreate).not.toHaveBeenCalled();
  });
});

describe("group join roster writes (#1039 items 2 and 3)", () => {
  const groupJoin = { groupBookingId: "group-1", joinerMemberId: "member-1" };

  beforeEach(() => {
    vi.clearAllMocks();
    createdCount = 0;
    h.transaction.mockImplementation(async (fn: (store: typeof tx) => Promise<unknown>) => fn(tx));
    h.executeRaw.mockResolvedValue(undefined);
    h.seasonFindMany.mockResolvedValue(mockSeasons);
    h.checkCapacityForGuestRanges.mockResolvedValue({ available: true, nightDetails: [] });
    h.reconcileBedAllocationsForBooking.mockResolvedValue(undefined);
    h.bookingUpdate.mockResolvedValue({});
    h.memberFindUnique.mockResolvedValue({ id: "member-1", firstName: "Mem", lastName: "Ber", email: "m@example.com" });
    h.bookingCreate.mockImplementation((args: { data: Record<string, unknown> }) => {
      createdCount += 1;
      const id = `booking-${createdCount}`;
      const guestRows = (args.data.guests as { create: Array<Record<string, unknown>> }).create.map(
        (g, i) => ({ ...g, id: `${id}-g${i}` })
      );
      return Promise.resolve({ ...args.data, id, guests: guestRows });
    });
    h.groupJoinFindUnique.mockResolvedValue(null);
    h.groupJoinCreate.mockResolvedValue({ id: "join-1" });
    h.groupJoinUpdate.mockResolvedValue({ id: "join-1" });
  });

  it("writes the roster row inside the booking transaction", async () => {
    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { groupJoin })
    );

    expect(outcome.type).toBe("created");
    expect(h.groupJoinCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupBookingId: "group-1",
        joinerMemberId: "member-1",
        bookingId: "booking-1",
        isMember: true,
      }),
    });
  });

  it("reuses a roster row left by a cancelled join", async () => {
    h.groupJoinFindUnique.mockResolvedValue({
      id: "join-old",
      booking: { status: BookingStatus.CANCELLED, deletedAt: null },
    });

    const outcome = await createConfirmedBooking(
      baseInput([guest(true, "Alice")], { groupJoin })
    );

    expect(outcome.type).toBe("created");
    expect(h.groupJoinUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "join-old" },
        data: expect.objectContaining({ bookingId: "booking-1" }),
      })
    );
    expect(h.groupJoinCreate).not.toHaveBeenCalled();
  });

  it("aborts the transaction when the joiner already has a live join", async () => {
    h.groupJoinFindUnique.mockResolvedValue({
      id: "join-live",
      booking: { status: BookingStatus.CONFIRMED, deletedAt: null },
    });

    await expect(
      createConfirmedBooking(baseInput([guest(true, "Alice")], { groupJoin }))
    ).rejects.toBeInstanceOf(GroupJoinConflictError);

    expect(h.groupJoinCreate).not.toHaveBeenCalled();
    expect(h.groupJoinUpdate).not.toHaveBeenCalled();
  });

  it("takes the serialising advisory lock before any duplicate checks (#1039 item 3)", async () => {
    // The person-night guard and the roster duplicate check are app-level
    // enforcement; they are race-free because every creation transaction
    // first takes pg_advisory_xact_lock(1). Freeze that ordering.
    await createConfirmedBooking(baseInput([guest(true, "Alice")], { groupJoin }));

    const lockOrder = h.executeRaw.mock.invocationCallOrder[0];
    const rosterCheckOrder = h.groupJoinFindUnique.mock.invocationCallOrder[0];
    const bookingCreateOrder = h.bookingCreate.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(bookingCreateOrder);
    expect(lockOrder).toBeLessThan(rosterCheckOrder);
  });
});
