import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PaymentSource, PaymentStatus } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  loadEffectiveModuleFlags: vi.fn(),
  findUnique: vi.fn(),
  upsert: vi.fn(),
  bookingUpdate: vi.fn(),
  settingsFindUnique: vi.fn(),
  transaction: vi.fn(),
  txExecuteRaw: vi.fn(),
  recordInternetBankingPaymentTransaction: vi.fn(),
  cancelPaymentIntentIfCancellable: vi.fn(),
  enqueueXeroBookingInvoiceOperation: vi.fn(),
  kickQueuedXeroOutboxOperationsIfConnected: vi.fn(),
  isXeroConnected: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }),
    },
    booking: { findUnique: mocks.findUnique, update: mocks.bookingUpdate },
    payment: { upsert: mocks.upsert },
    internetBankingPaymentSettings: { findUnique: mocks.settingsFindUnique },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/payment-transactions", () => ({
  recordInternetBankingPaymentTransaction:
    mocks.recordInternetBankingPaymentTransaction,
}));
vi.mock("@/lib/stripe", () => ({
  cancelPaymentIntentIfCancellable: mocks.cancelPaymentIntentIfCancellable,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXeroBookingInvoiceOperation,
  kickQueuedXeroOutboxOperationsIfConnected:
    mocks.kickQueuedXeroOutboxOperationsIfConnected,
}));
vi.mock("@/lib/xero", () => ({ isXeroConnected: mocks.isXeroConnected }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// Internet Banking module gate. Partial-mock so the module's other exports
// (used transitively) stay intact.
vi.mock("@/lib/module-settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/module-settings")>(
    "@/lib/module-settings"
  );
  return { ...actual, loadEffectiveModuleFlags: mocks.loadEffectiveModuleFlags };
});

import { POST } from "@/app/api/payments/switch-to-internet-banking/route";

// buildInternetBankingPaymentReference uppercases the first 8 chars of the id.
const BOOKING_ID = "abcd1234-booking";
const REFERENCE = "BOOKING-ABCD1234";

function postRequest(body: unknown = { bookingId: BOOKING_ID }) {
  return new NextRequest(
    "http://localhost/api/payments/switch-to-internet-banking",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }
  );
}

/** A payable Stripe (card) booking the owner can still switch. */
function stripeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    memberId: "member-1",
    status: "PAYMENT_PENDING",
    hasNonMembers: false,
    organiserSettled: false,
    finalPriceCents: 4500,
    payment: {
      source: PaymentSource.STRIPE,
      status: PaymentStatus.PENDING,
      stripePaymentIntentId: "pi_123",
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ user: { id: "member-1", role: "MEMBER", accessRoles: [{ role: "USER" }] } });
  mocks.requireActiveSessionUser.mockResolvedValue(null);
  mocks.loadEffectiveModuleFlags.mockResolvedValue({
    xeroIntegration: true,
    internetBankingPayments: true,
  });
  mocks.findUnique.mockResolvedValue(stripeBooking());
  mocks.upsert.mockResolvedValue({ id: "payment-1" });
  mocks.bookingUpdate.mockResolvedValue({});
  // Settings singleton: null → defaults (holdBedSlots false, no lead-time gate),
  // so the switch stays PAYMENT_PENDING without a capacity re-check.
  mocks.settingsFindUnique.mockResolvedValue(null);
  mocks.txExecuteRaw.mockResolvedValue(undefined);
  // The route now finalises the payment switch inside a Prisma transaction; run
  // the callback against a tx client that mirrors the production surface.
  mocks.transaction.mockImplementation(
    async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $executeRaw: mocks.txExecuteRaw,
        $queryRaw: vi.fn().mockResolvedValue([]),
        lodge: { findFirst: vi.fn().mockResolvedValue({ id: "lodge-1" }) },
        payment: { upsert: mocks.upsert },
        booking: { update: mocks.bookingUpdate },
      })
  );
  mocks.cancelPaymentIntentIfCancellable.mockResolvedValue(undefined);
  mocks.enqueueXeroBookingInvoiceOperation.mockResolvedValue({
    queueOperationId: "queue-1",
  });
  mocks.kickQueuedXeroOutboxOperationsIfConnected.mockResolvedValue(undefined);
  mocks.isXeroConnected.mockResolvedValue(true);
});

describe("POST /api/payments/switch-to-internet-banking", () => {
  it("rejects an unauthenticated caller with 401", async () => {
    mocks.auth.mockResolvedValueOnce(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(401);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an inactive session before touching the booking", async () => {
    mocks.requireActiveSessionUser.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "inactive" }), { status: 403 })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(403);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("rejects with 400 when the Internet Banking module is off", async () => {
    mocks.loadEffectiveModuleFlags.mockResolvedValueOnce({
      xeroIntegration: false,
      internetBankingPayments: false,
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Internet Banking payments are not available.",
    });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid body", async () => {
    const res = await POST(postRequest({ nope: true }));
    expect(res.status).toBe(400);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 when the booking does not exist", async () => {
    mocks.findUnique.mockResolvedValueOnce(null);
    const res = await POST(postRequest());
    expect(res.status).toBe(404);
  });

  it("returns 403 when the caller is neither the owner nor an admin", async () => {
    mocks.auth.mockResolvedValueOnce({
      user: { id: "someone-else", role: "MEMBER", accessRoles: [{ role: "USER" }] },
    });
    const res = await POST(postRequest());
    expect(res.status).toBe(403);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("lets an admin switch on behalf of the booking owner", async () => {
    mocks.auth.mockResolvedValueOnce({ user: { id: "admin-9", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalled();
  });

  it("rejects an organiser-settled booking with 400", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ organiserSettled: true })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("is idempotent when the booking is already Internet Banking", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({
        payment: {
          source: PaymentSource.INTERNET_BANKING,
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: null,
        },
      })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ reference: REFERENCE });
    // No re-conversion work.
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.enqueueXeroBookingInvoiceOperation).not.toHaveBeenCalled();
  });

  it("rejects a booking that is not immediately payable (wrong status)", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ status: "CONFIRMED" })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a saved-card hold (non-member) booking that cannot charge now", async () => {
    // A non-member hold sits at PENDING and uses a saved card, not an
    // immediate charge — so it must not be switchable to Internet Banking.
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ status: "PENDING", hasNonMembers: true })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a zero-dollar booking with nothing to pay", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({ finalPriceCents: 0 })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a booking whose payment already succeeded", async () => {
    mocks.findUnique.mockResolvedValueOnce(
      stripeBooking({
        payment: {
          source: PaymentSource.STRIPE,
          status: PaymentStatus.SUCCEEDED,
          stripePaymentIntentId: "pi_123",
        },
      })
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(400);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("converts a Stripe booking to Internet Banking and raises the invoice", async () => {
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    // Default settings hold no beds, so the response reports the reference plus
    // the (empty) hold policy.
    await expect(res.json()).resolves.toEqual({
      reference: REFERENCE,
      holdBedSlots: false,
      holdUntil: null,
    });

    // Voids the open Stripe intent.
    expect(mocks.cancelPaymentIntentIfCancellable).toHaveBeenCalledWith("pi_123");

    // Flips the payment to Internet Banking, clearing the Stripe intent.
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { bookingId: BOOKING_ID },
        update: expect.objectContaining({
          source: PaymentSource.INTERNET_BANKING,
          reference: REFERENCE,
          status: PaymentStatus.PENDING,
          stripePaymentIntentId: null,
        }),
      })
    );

    // Records the IB transaction and queues the emailed Xero invoice.
    expect(mocks.recordInternetBankingPaymentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ reference: REFERENCE })
    );
    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenCalledWith(
      BOOKING_ID,
      expect.objectContaining({ createdByMemberId: "member-1" })
    );
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).toHaveBeenCalled();
  });

  it("does not kick the outbox when Xero is disconnected", async () => {
    mocks.isXeroConnected.mockResolvedValueOnce(false);
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mocks.enqueueXeroBookingInvoiceOperation).toHaveBeenCalled();
    expect(mocks.kickQueuedXeroOutboxOperationsIfConnected).not.toHaveBeenCalled();
  });

  it("still succeeds when a Stripe intent cannot be cancelled", async () => {
    mocks.cancelPaymentIntentIfCancellable.mockRejectedValueOnce(
      new Error("stripe down")
    );
    const res = await POST(postRequest());
    expect(res.status).toBe(200);
    expect(mocks.upsert).toHaveBeenCalled();
  });
});
