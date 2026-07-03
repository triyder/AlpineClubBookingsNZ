import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus, PaymentStatus } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentLink: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    payment: {
      upsert: vi.fn(),
    },
    booking: {
      findUnique: vi.fn(),
    },
    bookingEvent: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("@/lib/stripe", () => ({
  createPaymentIntent: vi.fn(),
  findOrCreateCustomer: vi.fn(),
  getPaymentIntent: vi.fn(),
}));

vi.mock("@/lib/email", () => ({
  sendBookingRequestApprovedEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: vi.fn(),
}));

vi.mock("@/lib/booking-payment-cleanup", () => ({
  queueSupersededPrimaryIntentCancellations: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: vi.fn(),
}));

const { loadEffectiveModuleFlagsMock, queueXeroInvoiceForPaidBookingMock } = vi.hoisted(() => ({
  loadEffectiveModuleFlagsMock: vi.fn(),
  queueXeroInvoiceForPaidBookingMock: vi.fn(),
}));
// Partial-mock so the module's other exports stay intact for transitive imports.
vi.mock("@/lib/module-settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/module-settings")>(
    "@/lib/module-settings"
  );
  return { ...actual, loadEffectiveModuleFlags: loadEffectiveModuleFlagsMock };
});

vi.mock("@/lib/xero-booking-invoice-queue", () => ({
  queueXeroInvoiceForPaidBooking: queueXeroInvoiceForPaidBookingMock,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { createPaymentIntent, findOrCreateCustomer, getPaymentIntent } from "@/lib/stripe";
import { markBookingPaymentSucceeded } from "@/lib/payment-reconciliation";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { sendBookingRequestApprovedEmail } from "@/lib/email";
import {
  createPaymentIntentForPaymentLink,
  getPaymentLinkContext,
  reissuePaymentLinkForToken,
  resolvePaymentLink,
  revokePaymentLinksForBooking,
} from "@/lib/payment-link";

const mockedFindUnique = vi.mocked(prisma.paymentLink.findUnique);
const mockedUpdate = vi.mocked(prisma.paymentLink.update);
const mockedUpdateMany = vi.mocked(prisma.paymentLink.updateMany);
const mockedBookingEventFindMany = vi.mocked(prisma.bookingEvent.findMany);
const mockedTransaction = vi.mocked(prisma.$transaction);
const mockedGetPaymentIntent = vi.mocked(getPaymentIntent);
const mockedCreatePaymentIntent = vi.mocked(createPaymentIntent);
const mockedFindOrCreateCustomer = vi.mocked(findOrCreateCustomer);
const mockedMarkSucceeded = vi.mocked(markBookingPaymentSucceeded);
const mockedCheckCapacity = vi.mocked(checkCapacityForGuestRanges);

const RAW_TOKEN = issueActionToken().token;

function baseLink(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "link-1",
    bookingId: "booking-1",
    bookingRequestId: "req-1",
    tokenHash: hashActionToken(RAW_TOKEN),
    revokedAt: null,
    usedAt: null,
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    booking: baseBooking(),
    ...overrides,
  };
}

function baseBooking(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "booking-1",
    memberId: "member-1",
    status: BookingStatus.PENDING,
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-03T00:00:00.000Z"),
    finalPriceCents: 12000,
    deletedAt: null,
    member: { id: "member-1", email: "tara@example.com", firstName: "Tara", lastName: "Tester" },
    guests: [{ id: "guest-1" }],
    payment: null,
    ...overrides,
  };
}

describe("resolvePaymentLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects tokens that are not 64-char hex without a DB lookup", async () => {
    await expect(resolvePaymentLink("not-a-token")).rejects.toMatchObject({ status: 404 });
    expect(mockedFindUnique).not.toHaveBeenCalled();
  });

  it("returns a generic 404 for an unknown token", async () => {
    mockedFindUnique.mockResolvedValue(null);
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 404 });
  });

  it("returns a generic 404 when the booking has been soft-deleted", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ deletedAt: new Date() }) }) as never
    );
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 404 });
  });

  it("returns 410 for a revoked link", async () => {
    mockedFindUnique.mockResolvedValue(baseLink({ revokedAt: new Date() }) as never);
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
  });

  it("returns 410 for a used link on a booking that isn't PAID", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ usedAt: new Date(), booking: baseBooking({ status: BookingStatus.PENDING }) }) as never
    );
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
  });

  it("returns 410 for an expired link on a booking that isn't PAID", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }) as never
    );
    await expect(resolvePaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
  });

  it("allows a used/expired link through when the booking is already PAID (idempotent paid view)", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        usedAt: new Date(),
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        booking: baseBooking({ status: BookingStatus.PAID }),
      }) as never
    );
    const link = await resolvePaymentLink(RAW_TOKEN);
    expect(link.booking.status).toBe(BookingStatus.PAID);
  });

  it("looks up the link by the hash of the supplied token, not the raw token", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    await resolvePaymentLink(RAW_TOKEN);
    expect(mockedFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashActionToken(RAW_TOKEN) } })
    );
  });
});

describe("getPaymentLinkContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBookingEventFindMany.mockResolvedValue([] as never);
    // Internet Banking module on by default.
    loadEffectiveModuleFlagsMock.mockResolvedValue({
      xeroIntegration: true,
      internetBankingPayments: true,
    });
  });

  it("returns a payable context for a PENDING booking without marking the link used", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("payable");
    expect(context.payable?.amountCents).toBe(12000);
    expect(context.payable?.status).toBe(BookingStatus.PENDING);
    // Internet Banking is on, so the bank-transfer reference is offered.
    expect(context.payable?.internetBankingReference).toBe("BOOKING-BOOKING-");
    expect(context.narrative.message).toContain("$120.00");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("omits the internet banking reference when the module is off", async () => {
    loadEffectiveModuleFlagsMock.mockResolvedValue({
      xeroIntegration: false,
      internetBankingPayments: false,
    });
    mockedFindUnique.mockResolvedValue(baseLink() as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("payable");
    expect(context.payable?.internetBankingReference).toBeUndefined();
  });

  it("returns a paid context and marks the link as used for a PAID booking", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.PAID }) }) as never
    );
    mockedUpdate.mockResolvedValue({} as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("paid");
    expect(context.payable).toBeNull();
    expect(mockedUpdate).toHaveBeenCalledWith({
      where: { id: "link-1" },
      data: { usedAt: expect.any(Date) },
    });
  });

  it("treats a COMPLETED booking like PAID (no 'already used' error) and marks the link used", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        usedAt: new Date(),
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
        booking: baseBooking({ status: BookingStatus.COMPLETED }),
      }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("paid");
    // Link already marked used — not re-marked.
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("does not re-mark a PAID booking's link as used if already marked", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        usedAt: new Date(),
        booking: baseBooking({ status: BookingStatus.PAID }),
      }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("paid");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("shows an expired-but-payable narrative (not an error) when the link has expired", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("expired_payable");
    expect(context.canRequestFreshLink).toBe(true);
    expect(context.payable).toBeNull();
  });

  it("shows a bumped narrative (not an error) once the booking was bumped", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );
    mockedBookingEventFindMany.mockResolvedValue([
      {
        type: "BUMPED",
        occurredAt: new Date("2026-07-01T00:00:00.000Z"),
        amountCents: null,
        reason: null,
        snapshot: { flagged: false },
      },
    ] as never);

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("bumped");
    expect(context.narrative.message).toMatch(/filled up/i);
  });

  it("shows a clear cancelled narrative (not an error) once the booking is CANCELLED", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );

    const context = await getPaymentLinkContext(RAW_TOKEN);

    expect(context.state).toBe("cancelled_pre_payment");
    expect(context.narrative.message).toMatch(/cancelled/i);
  });
});

describe("reissuePaymentLinkForToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedTransaction.mockImplementation(
      async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma)
    );
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.paymentLink.create).mockResolvedValue({} as never);
  });

  it("issues a fresh link and emails it for an expired-but-payable booking", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ expiresAt: new Date("2000-01-01T00:00:00.000Z") }) as never
    );

    const result = await reissuePaymentLinkForToken(RAW_TOKEN);

    expect(result.emailed).toBe(true);
    expect(vi.mocked(prisma.paymentLink.create)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bookingId: "booking-1" }),
      })
    );
    expect(sendBookingRequestApprovedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tara@example.com" })
    );
  });

  it("refuses to re-issue a link for a booking that can no longer be paid", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );

    await expect(reissuePaymentLinkForToken(RAW_TOKEN)).rejects.toMatchObject({
      status: 410,
    });
    expect(sendBookingRequestApprovedEmail).not.toHaveBeenCalled();
  });
});

describe("revokePaymentLinksForBooking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("revokes only active, unused links for the booking", async () => {
    mockedUpdateMany.mockResolvedValue({ count: 1 } as never);

    const count = await revokePaymentLinksForBooking("booking-1");

    expect(count).toBe(1);
    expect(mockedUpdateMany).toHaveBeenCalledWith({
      where: { bookingId: "booking-1", revokedAt: null, usedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

describe("createPaymentIntentForPaymentLink", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueXeroInvoiceForPaidBookingMock.mockResolvedValue({
      queueOperationId: "xero-op-1",
      message: "queued",
    });
    mockedTransaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma)
    );
    mockedCheckCapacity.mockResolvedValue({ available: true, minAvailable: 5, nightDetails: [] } as never);
  });

  it("throws USED_LINK_MESSAGE when the booking is already PAID", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.PAID }) }) as never
    );

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("throws NOT_PAYABLE_MESSAGE for a CANCELLED booking", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({ booking: baseBooking({ status: BookingStatus.CANCELLED }) }) as never
    );

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 410 });
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("reuses an existing PaymentIntent's client secret instead of creating a new one", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: { id: "pay-1", stripePaymentIntentId: "pi_existing", status: PaymentStatus.PENDING },
        }),
      }) as never
    );
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_existing",
      status: "requires_payment_method",
      client_secret: "secret_existing",
      amount: 12000,
      payment_method: null,
    } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    expect(result).toEqual({ type: "clientSecret", clientSecret: "secret_existing", paymentIntentId: "pi_existing" });
    expect(mockedCreatePaymentIntent).not.toHaveBeenCalled();
  });

  it("supersedes a stale-amount intent and mints a fresh one at the current price (#1161)", async () => {
    const { queueSupersededPrimaryIntentCancellations } = await import(
      "@/lib/booking-payment-cleanup"
    );
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: { id: "pay-1", stripePaymentIntentId: "pi_stale", status: PaymentStatus.PENDING },
        }),
      }) as never
    );
    // Minted at $100 before the unpaid booking was edited to $120.
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_stale",
      status: "requires_payment_method",
      client_secret: "secret_stale",
      amount: 10000,
      payment_method: null,
    } as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "secret_new",
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    // The stale secret is never disclosed; a fresh intent carries the
    // current price and the stale one is queued for cancellation.
    expect(result).toEqual({
      type: "clientSecret",
      clientSecret: "secret_new",
      paymentIntentId: "pi_new",
    });
    expect(vi.mocked(queueSupersededPrimaryIntentCancellations)).toHaveBeenCalledWith(
      expect.anything(),
      {
        bookingId: "booking-1",
        paymentId: "pay-1",
        newFinalPriceCents: 12000,
      },
    );
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 12000 }),
    );
  });

  it("reports alreadyPaid and reconciles when the existing PaymentIntent already succeeded", async () => {
    mockedFindUnique.mockResolvedValue(
      baseLink({
        booking: baseBooking({
          payment: { id: "pay-1", stripePaymentIntentId: "pi_existing", status: PaymentStatus.PENDING },
        }),
      }) as never
    );
    mockedGetPaymentIntent.mockResolvedValue({
      id: "pi_existing",
      status: "succeeded",
      client_secret: "secret_existing",
      amount: 12000,
      payment_method: "pm_123",
    } as never);
    mockedMarkSucceeded.mockResolvedValue({ outcome: "confirmed" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    expect(result).toEqual({ type: "alreadyPaid", paymentIntentId: "pi_existing" });
    expect(mockedMarkSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: "booking-1", paymentIntentId: "pi_existing" })
    );
    expect(queueXeroInvoiceForPaidBookingMock).toHaveBeenCalledWith({
      bookingId: "booking-1",
    });
  });

  it("revalidates capacity under the advisory lock and refuses when beds are gone", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedCheckCapacity.mockResolvedValue({ available: false, minAvailable: -1, nightDetails: [] } as never);

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 409 });
    expect(mockedFindOrCreateCustomer).not.toHaveBeenCalled();
  });

  it("creates a new PaymentIntent for a fresh payable booking", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: "secret_new",
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    const result = await createPaymentIntentForPaymentLink(RAW_TOKEN);

    expect(result).toEqual({ type: "clientSecret", clientSecret: "secret_new", paymentIntentId: "pi_new" });
    expect(mockedFindOrCreateCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ email: "tara@example.com", memberId: "member-1" })
    );
    expect(mockedCreatePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 12000,
        metadata: expect.objectContaining({ bookingId: "booking-1", paymentLinkId: "link-1" }),
      })
    );
  });

  it("throws when the booking has no client secret available", async () => {
    mockedFindUnique.mockResolvedValue(baseLink() as never);
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      baseBooking({ guests: [{ id: "guest-1" }] }) as never
    );
    mockedFindOrCreateCustomer.mockResolvedValue({ id: "cus_123" } as never);
    mockedCreatePaymentIntent.mockResolvedValue({
      id: "pi_new",
      client_secret: null,
      amount: 12000,
    } as never);
    vi.mocked(prisma.payment.upsert).mockResolvedValue({ id: "pay-1" } as never);

    await expect(createPaymentIntentForPaymentLink(RAW_TOKEN)).rejects.toMatchObject({ status: 500 });
  });
});
