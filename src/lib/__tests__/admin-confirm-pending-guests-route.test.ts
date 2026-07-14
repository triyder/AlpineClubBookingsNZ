import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  bookingFindUnique: vi.fn(),
  bookingUpdate: vi.fn(),
  bookingUpdateMany: vi.fn(),
  paymentUpsert: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  checkCapacity: vi.fn(),
  chargePaymentMethod: vi.fn(),
  markBookingPaymentSucceeded: vi.fn(),
  reconcile: vi.fn(),
  enqueueXero: vi.fn(),
  kickXero: vi.fn(),
  sendConfirmedEmail: vi.fn(),
  sendPaymentFailureAlert: vi.fn(),
  upsertPaymentIntentTransaction: vi.fn(),
  createStructuredAuditLog: vi.fn(),
  getAuditRequestContext: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findUnique: mocks.bookingFindUnique,
      update: mocks.bookingUpdate,
      updateMany: mocks.bookingUpdateMany,
    },
    payment: { upsert: mocks.paymentUpsert },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/capacity", () => ({
  checkCapacityForGuestRanges: mocks.checkCapacity,
}));
vi.mock("@/lib/stripe", () => ({ chargePaymentMethod: mocks.chargePaymentMethod }));
vi.mock("@/lib/payment-reconciliation", () => ({
  markBookingPaymentSucceeded: mocks.markBookingPaymentSucceeded,
}));
vi.mock("@/lib/bed-allocation-lifecycle", () => ({
  reconcileBedAllocationsForBooking: mocks.reconcile,
}));
vi.mock("@/lib/xero-operation-outbox", () => ({
  enqueueXeroBookingInvoiceOperation: mocks.enqueueXero,
  kickQueuedXeroOutboxOperationsIfConnected: mocks.kickXero,
}));
vi.mock("@/lib/email", () => ({
  sendBookingConfirmedEmail: mocks.sendConfirmedEmail,
  sendAdminPaymentFailureAlert: mocks.sendPaymentFailureAlert,
}));
vi.mock("@/lib/payment-transactions", () => ({
  upsertPaymentIntentTransaction: mocks.upsertPaymentIntentTransaction,
}));
vi.mock("@/lib/audit", () => ({
  createStructuredAuditLog: mocks.createStructuredAuditLog,
  getAuditRequestContext: mocks.getAuditRequestContext,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/bookings/[id]/confirm-pending-guests/route";

const params = Promise.resolve({ id: "b1" });

// Transaction client the route receives inside prisma.$transaction. Reuses the
// same underlying mocks so assertions on booking.updateMany / payment.upsert
// see the calls made inside the advisory-locked transaction too.
const txClient = {
  $executeRaw: mocks.executeRaw,
  booking: {
    findUnique: mocks.bookingFindUnique,
    update: mocks.bookingUpdate,
    updateMany: mocks.bookingUpdateMany,
  },
  payment: { upsert: mocks.paymentUpsert },
};

function makeRequest(body?: Record<string, unknown>) {
  return new NextRequest(
    "https://example.test/api/admin/bookings/b1/confirm-pending-guests",
    {
      method: "POST",
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    }
  );
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "b1",
    memberId: "m1",
    lodgeId: "lodge-1",
    status: "PENDING",
    hasNonMembers: true,
    nonMemberHoldUntil: new Date("2026-07-08"),
    checkIn: new Date("2026-07-15"),
    checkOut: new Date("2026-07-17"),
    finalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    member: { email: "m@example.com", firstName: "Pat", lastName: "Lee" },
    guests: [{ id: "g1" }, { id: "g2" }],
    payment: { stripePaymentMethodId: "pm_1", stripeCustomerId: "cus_1" },
    promoRedemption: null,
    ...overrides,
  };
}

const AVAILABLE = { available: true, minAvailable: 5, nightDetails: [] };
const FULL = {
  available: false,
  minAvailable: -1,
  nightDetails: [
    {
      date: new Date("2026-07-15T00:00:00.000Z"),
      occupiedBeds: 25,
      availableBeds: -1,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } },
  });
  mocks.getAuditRequestContext.mockReturnValue({});
  mocks.createStructuredAuditLog.mockResolvedValue(undefined);
  mocks.reconcile.mockResolvedValue({ enabled: false, deletedCount: 0, createdCount: 0 });
  mocks.bookingUpdate.mockResolvedValue({});
  mocks.bookingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.paymentUpsert.mockResolvedValue({ id: "pay1" });
  mocks.sendPaymentFailureAlert.mockResolvedValue(undefined);
  mocks.upsertPaymentIntentTransaction.mockResolvedValue(undefined);
  mocks.executeRaw.mockResolvedValue(1);
  // Default: capacity is available. Each test that needs a full lodge overrides.
  mocks.checkCapacity.mockResolvedValue(AVAILABLE);
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(txClient)
  );
  mocks.enqueueXero.mockResolvedValue({ queueOperationId: null });
  mocks.kickXero.mockResolvedValue({});
  mocks.sendConfirmedEmail.mockResolvedValue(undefined);
});

describe("POST /api/admin/bookings/[id]/confirm-pending-guests", () => {
  it("charges the saved card and confirms to PAID, clearing the hold", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ success: true, status: "PAID", charged: true });
    // The pre-charge capacity re-check runs under the advisory lock.
    expect(mocks.checkCapacity).toHaveBeenCalledWith(
      "lodge-1",
      expect.any(Date),
      expect.any(Date),
      expect.any(Array),
      "b1",
      txClient
    );
    expect(mocks.chargePaymentMethod).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: 10000, idempotencyKey: "pending_charge_b1" })
    );
    // Claim-first (#1418): capacity is claimed as CONFIRMED (hold cleared)
    // BEFORE Stripe is touched, mirroring the cron.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "CONFIRMED", nonMemberHoldUntil: null },
    });
    expect(
      mocks.bookingUpdateMany.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.chargePaymentMethod.mock.invocationCallOrder[0]);
    // The captured charge is durably recorded before reconciliation.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: "pay1",
        paymentIntentId: "pi_1",
        amountCents: 10000,
        status: "SUCCEEDED",
      })
    );
    expect(
      mocks.upsertPaymentIntentTransaction.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.markBookingPaymentSucceeded.mock.invocationCallOrder[0]);
    expect(mocks.createStructuredAuditLog).toHaveBeenCalled();
  });

  it("does not charge when capacity is full, returning 409 CAPACITY_EXCEEDED", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkCapacity.mockResolvedValue(FULL);

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-07-15"],
    });
    // Gated before Stripe: the card is never touched on a full lodge.
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("charges past a full lodge when allowOverbook is set", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkCapacity.mockResolvedValue(FULL);
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAID", charged: true });
    expect(mocks.chargePaymentMethod).toHaveBeenCalled();
    // #1771: claiming CONFIRMED over the ceiling stamps the persisted override
    // with the acting admin, so the later markBookingPaymentSucceeded re-check
    // never cancels the deliberately-admitted booking.
    const confirmClaim = mocks.bookingUpdateMany.mock.calls.find(
      (c) => (c[0] as { data: { status: string } }).data.status === "CONFIRMED"
    );
    const confirmData = (confirmClaim?.[0] as { data: Record<string, unknown> }).data;
    expect(confirmData.capacityOverriddenAt).toBeInstanceOf(Date);
    expect(confirmData.capacityOverriddenByMemberId).toBe("admin1");
  });

  // ADR-001 decision 5 (issue #118): an exclusive whole-lodge hold on the target
  // nights is NOT bypassable — even with allowOverbook the confirm is refused,
  // before any CONFIRMED claim, Stripe charge, or $0 PAID advance.
  const HELD = {
    available: false,
    minAvailable: 0,
    nightDetails: [
      {
        date: new Date("2026-07-15T00:00:00.000Z"),
        occupiedBeds: 4,
        // Pinned to 0 (never negative) so it never appears in overbookDates.
        availableBeds: 0,
        wholeLodgeHeld: true,
      },
    ],
  };

  it("refuses the charge branch with 409 WHOLE_LODGE_HOLD_BLOCKED even with allowOverbook, never charging or claiming", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.checkCapacity.mockResolvedValue(HELD);

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(body.code).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(body.blockedNights).toEqual(["2026-07-15"]);
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
  });

  it("refuses the $0 branch with 409 WHOLE_LODGE_HOLD_BLOCKED even with allowOverbook, never advancing to PAID", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));
    mocks.checkCapacity.mockResolvedValue(HELD);

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toBe("WHOLE_LODGE_HOLD_BLOCKED");
    expect(body.blockedNights).toEqual(["2026-07-15"]);
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpsert).not.toHaveBeenCalled();
  });

  // #1418: charge captured, then reconciliation throws (e.g. transient DB
  // failure or a concurrent status change). The captured money must never go
  // silent: the transaction row is already durably recorded (webhook can
  // finish the promotion), the claim keeps holding the beds, and admins are
  // alerted.
  it("alerts and leaves the booking claimed when reconciliation fails after a captured charge (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockRejectedValue(
      new Error("Booking is not payable from status CANCELLED")
    );

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ paymentIntentId: "pi_1" });
    expect(body.error).toContain("charge succeeded");
    // The captured charge was durably recorded BEFORE reconciliation ran.
    expect(mocks.upsertPaymentIntentTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ paymentIntentId: "pi_1", status: "SUCCEEDED" })
    );
    // Admins are alerted with the intent id.
    expect(mocks.sendPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: "pi_1",
        amountCents: 10000,
        errorMessage: expect.stringContaining("captured"),
      })
    );
    // The claim is NOT released — CONFIRMED keeps holding the paid-for beds.
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING" }),
      })
    );
    // No confirmation email for an unfinalised booking.
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
  });

  it("releases the claim and alerts when the Stripe charge itself fails (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockRejectedValue(new Error("card_declined"));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toContain("charge failed");
    // Claim released: CONFIRMED -> PENDING with the original hold restored.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: new Date("2026-07-08"),
      },
    });
    expect(mocks.sendPaymentFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 10000,
        errorMessage: "card_declined",
      })
    );
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.upsertPaymentIntentTransaction).not.toHaveBeenCalled();
  });

  it("releases the claim without alerting when the card needs further authorisation (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "requires_action",
      amount: 10000,
      payment_method: "pm_1",
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({ paymentStatus: "requires_action" });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "CONFIRMED" },
      data: {
        status: "PENDING",
        nonMemberHoldUntil: new Date("2026-07-08"),
      },
    });
    expect(mocks.markBookingPaymentSucceeded).not.toHaveBeenCalled();
    expect(mocks.sendPaymentFailureAlert).not.toHaveBeenCalled();
  });

  it("reports the auto-refund accurately when the final capacity claim fails (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "cancelled_refunded",
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toContain("refunded in full");
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
    expect(mocks.enqueueXero).not.toHaveBeenCalled();
  });

  it("surfaces a refund failure after a capacity-failed charge as a 500 (#1418)", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking());
    mocks.chargePaymentMethod.mockResolvedValue({
      id: "pi_1",
      status: "succeeded",
      amount: 10000,
      payment_method: "pm_1",
    });
    mocks.markBookingPaymentSucceeded.mockResolvedValue({
      outcome: "cancelled_refund_failed",
    });

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({ paymentIntentId: "pi_1" });
    expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
  });

  it("moves a no-card (request-origin) booking to payment-owed without charging or capacity gate", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ payment: null }));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAYMENT_PENDING", charged: false });
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAYMENT_PENDING", nonMemberHoldUntil: null },
    });
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    // PAYMENT_PENDING is not capacity-holding, so no capacity re-check runs.
    expect(mocks.checkCapacity).not.toHaveBeenCalled();
  });

  it("confirms a $0 booking to PAID without charging when capacity is available", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAID", charged: false });
    expect(mocks.checkCapacity).toHaveBeenCalledWith(
      "lodge-1",
      expect.any(Date),
      expect.any(Date),
      expect.any(Array),
      "b1",
      txClient
    );
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: { status: "PAID", nonMemberHoldUntil: null },
    });
    expect(mocks.paymentUpsert).toHaveBeenCalled();
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("blocks a $0 promote at full capacity with 409 CAPACITY_EXCEEDED and does not flip to PAID", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));
    mocks.checkCapacity.mockResolvedValue(FULL);

    const res = await POST(makeRequest(), { params });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: "CAPACITY_EXCEEDED",
      overbookDates: ["2026-07-15"],
    });
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
    expect(mocks.paymentUpsert).not.toHaveBeenCalled();
  });

  it("promotes a $0 booking at full capacity when allowOverbook is set", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeBooking({ finalPriceCents: 0 }));
    mocks.checkCapacity.mockResolvedValue(FULL);

    const res = await POST(makeRequest({ allowOverbook: true }), { params });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: "PAID", charged: false });
    // #1771: claiming a $0 booking PAID over the ceiling stamps the persisted
    // override with the acting admin.
    expect(mocks.bookingUpdateMany).toHaveBeenCalledWith({
      where: { id: "b1", status: "PENDING" },
      data: {
        status: "PAID",
        nonMemberHoldUntil: null,
        capacityOverriddenAt: expect.any(Date),
        capacityOverriddenByMemberId: "admin1",
      },
    });
  });

  it("rejects a booking with no pending non-member guests", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeBooking({ status: "PAID", nonMemberHoldUntil: null })
    );

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(409);
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
  });

  it("returns 404 when the booking is missing", async () => {
    mocks.bookingFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(), { params });
    expect(res.status).toBe(404);
  });

  it("rejects a non-admin via the requireAdmin guard", async () => {
    mocks.requireAdmin.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 403 }),
    });

    const res = await POST(makeRequest(), { params });

    expect(res.status).toBe(403);
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
    expect(mocks.chargePaymentMethod).not.toHaveBeenCalled();
    expect(mocks.bookingUpdateMany).not.toHaveBeenCalled();
  });

  // #1769b (#1705 semantics): the admin's per-action member-email choice. The
  // confirmation email only sends on the two paths that become PAID — the
  // zero-amount (paid_zero) and charged-card (paid_charged) outcomes — so the
  // audit records `notifyMember: false` only there. The payment-owed and
  // failure outcomes send no email and record no notify field.
  describe("member-email notify choice (#1769b)", () => {
    it("emails and records no notify field by default on the $0 path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest(), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).toMatchObject({ outcome: "paid_zero" });
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("suppresses the email and records notifyMember:false on the $0 path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest({ notifyMember: false }), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).toMatchObject({
        outcome: "paid_zero",
        notifyMember: false,
      });
    });

    it("emails and records no notify field when notifyMember is true on the $0 path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest({ notifyMember: true }), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).toHaveBeenCalledTimes(1);
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("suppresses the email and records notifyMember:false on the charged-card path", async () => {
      mocks.bookingFindUnique.mockResolvedValue(makeBooking());
      mocks.chargePaymentMethod.mockResolvedValue({
        id: "pi_1",
        status: "succeeded",
        amount: 10000,
        payment_method: "pm_1",
      });
      mocks.markBookingPaymentSucceeded.mockResolvedValue({ outcome: "paid" });

      const res = await POST(makeRequest({ notifyMember: false }), { params });

      expect(res.status).toBe(200);
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      const chargedCall = mocks.createStructuredAuditLog.mock.calls.find(
        (call) => call[0].metadata?.outcome === "paid_charged"
      );
      expect(chargedCall?.[0].metadata).toMatchObject({
        outcome: "paid_charged",
        notifyMember: false,
      });
    });

    it("records NO notify field on the payment-owed path even when notifyMember:false", async () => {
      // Priced booking with no saved card moves to payment-owed and emails no
      // one, so a suppression there is not real — no field is recorded.
      mocks.bookingFindUnique.mockResolvedValue(makeBooking({ payment: null }));

      const res = await POST(makeRequest({ notifyMember: false }), { params });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({ status: "PAYMENT_PENDING", charged: false });
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      const metadata = mocks.createStructuredAuditLog.mock.calls[0][0].metadata;
      expect(metadata).toMatchObject({ outcome: "payment_owed" });
      expect(metadata).not.toHaveProperty("notifyMember");
    });

    it("rejects a non-boolean notifyMember with 400 and no side effects", async () => {
      mocks.bookingFindUnique.mockResolvedValue(
        makeBooking({ finalPriceCents: 0 })
      );

      const res = await POST(makeRequest({ notifyMember: "false" }), { params });

      expect(res.status).toBe(400);
      expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
      expect(mocks.sendConfirmedEmail).not.toHaveBeenCalled();
      expect(mocks.createStructuredAuditLog).not.toHaveBeenCalled();
    });
  });
});
