/** #4047: synthetic migrated PostgreSQL discovery, completed-IB reproduction and post-await audience/lifecycle fences. */
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeRaceDbUrl } from "./support/race-db-url";
import { observationReviewContext } from "./support/booking-observation-fixtures";
import { CLUB_FORMAT_TEST } from "./support/club-format-fixture";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { observeInvoicePayables } from "@/lib/xero-invoice-payable-observation";
const session = { actor: "race-4047-owner" };
const RUN = process.env.RUN_CONCURRENCY_RACE_TESTS === "1";
const URL = process.env.CONCURRENCY_RACE_DATABASE_URL ?? "";
const owner = "race-4047-owner", officer = "race-4047-officer", guest = "race-4047-guest";
const booking = "race-4047-booking", lodge = "race-4047-lodge", modification = "race-4047-mod", task = "race-4047-task";
let prisma: PrismaClient;
let identities: typeof import("@/lib/booking-supplementary-invoice-identities");
let action: typeof import("@/app/(authenticated)/bookings/[id]/_lib/booking-detail-outstanding");
let history: typeof import("@/app/(authenticated)/bookings/[id]/_lib/booking-detail-history");
let editFinancialReviewOccurrenceKey: typeof import("@/lib/edit-financial-review-occurrence").editFinancialReviewOccurrenceKey;
const invoiceId = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;

async function clean() {
  await prisma.xeroObjectLink.deleteMany({ where: { localId: { in: [booking, modification, task] } } });
  await prisma.xeroSyncOperation.deleteMany({ where: { localId: { in: [booking, modification, task] } } });
  await prisma.manualRefundTask.deleteMany({ where: { bookingId: booking } });
  await prisma.bookingModification.deleteMany({ where: { bookingId: booking } });
  await prisma.payment.deleteMany({ where: { bookingId: booking } });
  await prisma.bookingGuest.deleteMany({ where: { bookingId: booking } });
  await prisma.booking.deleteMany({ where: { id: booking } });
}
async function instrument(localModel: string, localId: string, n: number, options: { receipt?: boolean; issued?: boolean } = {}) {
  const id = invoiceId(n);
  await prisma.xeroSyncOperation.create({ data: {
    id: `race-4047-op-${n}`, direction: "OUTBOUND", entityType: "INVOICE", operationType: "CREATE", localModel, localId,
    status: options.issued === false ? "PENDING" : "SUCCEEDED", queueType: "SUPPLEMENTARY_INVOICE", correlationKey: `race-4047-${n}`,
    xeroObjectType: "INVOICE", xeroObjectId: options.issued === false ? null : id,
    requestPayload: { queueType: "SUPPLEMENTARY_INVOICE", bookingId: booking, priceDiffCents: 3000, changeFeeCents: 0,
      ...(localModel !== "Booking" ? { bookingModificationId: modification } : {}),
      ...(localModel === "ManualRefundTask" ? { shortfallReviewTaskId: task } : {}), recordPayment: options.receipt ?? false },
  } });
  if (options.issued !== false) await prisma.xeroObjectLink.create({ data: { localModel, localId, xeroObjectType: "INVOICE", xeroObjectId: id, role: "SUPPLEMENTARY_INVOICE" } });
  return id;
}
function deps(onRead?: () => Promise<void>) {
  return { loadState: (bookingId: string, actorId: string) => action.loadBookingOutstandingState(bookingId, actorId, {
      session: async () => ({ user: { id: session.actor, role: "MEMBER", accessRoles: ["USER"], canLogin: true, twoFactorVerified: true } }) as never,
      // Synthetic sessions substitute for Next's request runtime; current role
      // and ownership projections below still read the actual migrated DB.
      active: async () => null,
      modules: async () => ({ xeroIntegration: true }) as never,
      connection: async () => ({ connected: true, tenantId: "synthetic-tenant", needsReentry: false, tokenExpiresAt: null }),
      format: async () => CLUB_FORMAT_TEST,
    }),
    authenticate: vi.fn(async () => ({ tenantId: "synthetic-tenant", xero: {} as never })),
    limit: vi.fn(async () => ({ success: true, limit: 60, remaining: 59, resetAt: 1 })),
    readInvoices: vi.fn(async ({ invoiceIds }: { invoiceIds: readonly string[] }) => {
      await onRead?.();
      return observeInvoicePayables({ Invoices: invoiceIds.map((InvoiceID) => ({ InvoiceID, InvoiceNumber: `INV-${InvoiceID.slice(-2)}`,
        Type: "ACCREC", CurrencyCode: CLUB_FORMAT_TEST.currencyCode, Status: "AUTHORISED", AmountDue: 12.34 })) }, invoiceIds, CLUB_FORMAT_TEST.currencyCode, new Date().toISOString());
    }),
  };
}
(RUN ? describe : describe.skip)("booking supplementary observation against isolated PostgreSQL", () => {
  beforeAll(async () => {
    assertSafeRaceDbUrl(URL, "4047 invoice observation"); process.env.DATABASE_URL = URL;
    ({ prisma } = await import("@/lib/prisma"));
    // This helper transitively imports Prisma: resolve it only after the guarded URL.
    ({ editFinancialReviewOccurrenceKey } = await import("@/lib/edit-financial-review-occurrence"));
    identities = await import("@/lib/booking-supplementary-invoice-identities");
    action = await import("@/app/(authenticated)/bookings/[id]/_lib/booking-detail-outstanding");
    history = await import("@/app/(authenticated)/bookings/[id]/_lib/booking-detail-history");
    await clean();
    await prisma.lodge.deleteMany({ where: { id: lodge } });
    await prisma.member.deleteMany({ where: { id: { in: [owner, officer, guest] } } });
    for (const id of [owner, officer, guest]) await prisma.member.create({ data: { id, email: `${id}@example.invalid`, passwordHash: "synthetic-unusable", firstName: "Observation", lastName: "Proof", canLogin: true,
      accessRoles: { create: { role: id === officer ? "ADMIN_READONLY" : "USER" } } } });
    await prisma.lodge.create({ data: { id: lodge, name: "Observation Proof Lodge", slug: "race-4047" } });
  }, 60_000);
  beforeEach(async () => {
    await clean(); session.actor = owner;
    await prisma.booking.create({ data: { id: booking, memberId: owner, lodgeId: lodge, checkIn: new Date("2026-06-01T00:00:00Z"), checkOut: new Date("2026-06-02T00:00:00Z"), status: "COMPLETED", totalPriceCents: 3000, finalPriceCents: 3000 } });
    await prisma.payment.create({ data: { bookingId: booking, amountCents: 0, status: "SUCCEEDED", source: "INTERNET_BANKING" } });
    await prisma.bookingModification.create({ data: { id: modification, bookingId: booking, memberId: officer, modificationType: "GUEST_ADD", previousData: {}, newData: {}, priceDiffCents: 3000 } });
    const context = observationReviewContext(booking, modification);
    await prisma.manualRefundTask.create({ data: { id: task, bookingId: booking, kind: "EDIT_FINANCIAL_REVIEW", status: "COMPLETED", amountCents: 1000, settlementDirection: "CHARGE_TO_MEMBER", reason: "Synthetic second ask", occurrenceKey: editFinancialReviewOccurrenceKey(context.occurrence), reviewContext: context as never } });
    for (const memberId of [officer, guest]) await prisma.bookingGuest.create({ data: { bookingId: booking, memberId, firstName: "Guest", lastName: "Proof", ageTier: "ADULT", isMember: true, priceCents: 0, stayStart: new Date("2026-06-01T00:00:00Z"), stayEnd: new Date("2026-06-02T00:00:00Z") } });
  });
  afterAll(async () => {
    if (!prisma) return; await clean();
    await prisma.lodge.deleteMany({ where: { id: lodge } });
    await prisma.member.deleteMany({ where: { id: { in: [owner, officer, guest] } } });
  });
  it("discovers all three anchors, recovers missing links and deduplicates replay links", async () => {
    const direct = await instrument("Booking", booking, 1);
    const edit = await instrument("BookingModification", modification, 2);
    const second = await instrument("ManualRefundTask", task, 3);
    await prisma.xeroObjectLink.deleteMany({ where: { xeroObjectId: second } });
    await prisma.xeroObjectLink.create({ data: { localModel: "Booking", localId: booking, xeroObjectType: "INVOICE", xeroObjectId: edit, role: "SUPPLEMENTARY_INVOICE" } });
    const result = await identities.readBookingSupplementaryInvoiceIdentities(booking);
    // Cross-anchor provenance on a replayed link comes from the same invoice's operation.
    expect(result.invoiceIds).toEqual([direct, edit, second]);
  });
  it("reproduces the finished zero-primary IB correction without false reassurance", async () => {
    await instrument("BookingModification", modification, 1);
    const result = await action.readBookingOutstandingAction(booking, owner, undefined, deps());
    expect(result.view).toMatchObject({ kind: "ready", observations: [{ kind: "payable", dueCents: 1234 }] });
    const current = result.state!;
    const narrative = await history.loadBookingDetailHistory({ booking: current.booking, viewer: current.viewer,
      club: bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST), format: CLUB_FORMAT_TEST, additionalCollectionPending: true });
    expect(narrative.bookingNarrative.message).not.toContain("No payment was required");
    expect(narrative.bookingNarrative.nextStep).not.toContain("Nothing more to do");
  });
  it("excludes a card receipt and reports an unissued invoice as unknown", async () => {
    await instrument("BookingModification", modification, 1, { receipt: true });
    await instrument("ManualRefundTask", task, 2, { issued: false });
    expect(await identities.readBookingSupplementaryInvoiceIdentities(booking)).toMatchObject({ invoiceIds: [], incomplete: true });
  });
  it("admits a read-only officer who is also a guest but withholds owner money from a plain guest", async () => {
    await instrument("BookingModification", modification, 1);
    session.actor = officer;
    expect((await action.readBookingOutstandingAction(booking, officer, undefined, deps())).view).toMatchObject({ audience: "officer" });
    session.actor = guest; const d = deps();
    expect((await action.readBookingOutstandingAction(booking, guest, undefined, d)).view).toEqual({ kind: "hidden" });
    expect(d.authenticate).not.toHaveBeenCalled();
  });
  it.each(["CANCELLED", "BUMPED"] as const)("stops %s before provider work", async (status) => {
    await prisma.booking.update({ where: { id: booking }, data: { status } }); const d = deps();
    expect((await action.readBookingOutstandingAction(booking, owner, undefined, d)).view).toEqual({ kind: "hidden" });
    expect(d.authenticate).not.toHaveBeenCalled();
  });
  it("drops the old owner's disclosure when ownership changes during the provider wait", async () => {
    await instrument("BookingModification", modification, 1);
    const d = deps(() => prisma.booking.update({ where: { id: booking }, data: { memberId: guest } }).then(() => undefined));
    expect((await action.readBookingOutstandingAction(booking, owner, undefined, d)).view).toEqual({ kind: "hidden" });
  });
  it("removes a captured card ask on the fresh post-provider read", async () => {
    await instrument("BookingModification", modification, 1);
    await prisma.payment.update({ where: { bookingId: booking }, data: { additionalAmountCents: 2500, additionalPaymentStatus: "PENDING" } });
    const d = deps(() => prisma.payment.update({ where: { bookingId: booking }, data: { additionalPaymentStatus: "SUCCEEDED" } }).then(() => undefined));
    expect((await action.readBookingOutstandingAction(booking, owner, undefined, d)).view).toMatchObject({ cardDueCents: 0 });
  });
});
