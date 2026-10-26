import { beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroClient } from "xero-node";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireActiveSessionUser: vi.fn() }));
import { readBookingOutstandingAction, type loadBookingOutstandingState } from "../_lib/booking-detail-outstanding";
import { hasOutstandingCollectionEvidence } from "@/lib/booking-outstanding-payment";
import type { InvoicePayableObservation } from "@/lib/xero-invoice-payable-observation";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";

type State = NonNullable<Awaited<ReturnType<typeof loadBookingOutstandingState>>>;
function state(changes: Partial<State> = {}): State {
  return { booking: { status: "COMPLETED", deletedAt: null, organiserSettled: false,
    payment: { additionalAmountCents: 2500, additionalPaymentStatus: "PENDING" } },
    viewer: { isBookingOwner: true, canSeeOwnerCredit: true }, collectable: true,
    identities: { invoiceIds: ["invoice-1"], incomplete: false, revision: "identities" },
    providerEligible: true, tenantId: "tenant", format: CLUB_FORMAT_TEST, revision: "revision", ...changes } as State;
}
function payable(invoiceId = "invoice-1"): InvoicePayableObservation {
  return { kind: "payable", invoiceId, invoiceNumber: "INV-EXTRA", reference: "Supplementary", dueCents: 1234, observedAt: "2026-07-01T00:00:00Z" };
}
const deps = () => ({ loadState: vi.fn().mockResolvedValue(state()),
  authenticate: vi.fn().mockResolvedValue({ tenantId: "tenant", xero: {} as XeroClient }),
  readInvoices: vi.fn().mockResolvedValue([payable()]),
  limit: vi.fn().mockResolvedValue({ success: true, limit: 60, remaining: 59, resetAt: 1 }),
});
beforeEach(() => { vi.stubEnv("AUTH_SECRET", "synthetic-observation-secret-over-32-characters"); });
describe("reauthorized bounded invoice observations", () => {
  it("checks local authority before auth, after auth and after provider; composes the current ask", async () => {
    const d = deps();
    const result = await readBookingOutstandingAction("booking", "owner", undefined, d);
    expect(result.view).toMatchObject({ kind: "ready", cardDueCents: 2500, observations: [payable()] });
    expect(d.loadState).toHaveBeenCalledTimes(3);
    expect(d.readInvoices).toHaveBeenCalledTimes(1);
  });
  it.each(["cancelled", "bumped", "deleted", "guest", "organiser"])("gates %s before any provider work", async () => {
    const d = deps();
    d.loadState.mockResolvedValue(state({ collectable: false, identities: null }));
    expect((await readBookingOutstandingAction("booking", "owner", undefined, d)).view).toEqual({ kind: "hidden" });
    expect(d.authenticate).not.toHaveBeenCalled(); expect(d.readInvoices).not.toHaveBeenCalled();
  });
  it("discards old disclosure on an ownership or permission change during the provider wait", async () => {
    const d = deps();
    d.loadState.mockResolvedValueOnce(state()).mockResolvedValueOnce(state()).mockResolvedValueOnce(null);
    expect((await readBookingOutstandingAction("booking", "owner", undefined, d)).view).toEqual({ kind: "hidden" });
  });
  it("gates cancellation during a slow authentication before HTTP starts", async () => {
    const d = deps();
    d.loadState.mockResolvedValueOnce(state()).mockResolvedValueOnce(state({ collectable: false }));
    expect((await readBookingOutstandingAction("booking", "owner", undefined, d)).view.kind).toBe("hidden");
    expect(d.readInvoices).not.toHaveBeenCalled();
  });
  it.each(["captured", "withdrawn"])("removes a %s card ask after provider wait", async (kind) => {
    const d = deps();
    const current = state();
    current.booking.payment!.additionalPaymentStatus = kind === "captured" ? "SUCCEEDED" : "PENDING";
    if (kind === "withdrawn") current.booking.payment!.additionalAmountCents = 0;
    d.loadState.mockResolvedValueOnce(state()).mockResolvedValueOnce(state()).mockResolvedValueOnce(current);
    expect((await readBookingOutstandingAction("booking", "owner", undefined, d)).view).toMatchObject({ cardDueCents: 0 });
  });
  it.each(["tenant", "identities", "audience", "module"])("invalidates observations when %s changes", async () => {
    const d = deps();
    d.loadState.mockResolvedValueOnce(state()).mockResolvedValueOnce(state()).mockResolvedValueOnce(state({ revision: "changed" }));
    expect((await readBookingOutstandingAction("booking", "owner", undefined, d)).view).toMatchObject({ incomplete: true, observations: [], nextCursor: null });
  });
  it("refuses a limiter denial without auth and treats provider failure as unknown after reauthorization", async () => {
    const d = deps(); d.limit.mockResolvedValue({ success: false, limit: 60, remaining: 0, resetAt: 1 });
    expect((await readBookingOutstandingAction("booking", "owner", undefined, d)).view).toMatchObject({ incomplete: true });
    expect(d.authenticate).not.toHaveBeenCalled();
    const failed = deps(); failed.readInvoices.mockRejectedValue(new Error("unavailable"));
    expect((await readBookingOutstandingAction("booking", "owner", undefined, failed)).view).toMatchObject({ incomplete: true, observations: [] });
    expect(failed.loadState).toHaveBeenCalledTimes(3);
  });
  it("reaches invoice 21 whose balance alone is positive without treating the zero prefix as a whole-booking total", async () => {
    const d = deps(); const population = state();
    population.booking.payment!.additionalAmountCents = 0;
    population.identities!.invoiceIds = Array.from({ length: 21 }, (_, index) => `invoice-${index}`);
    d.loadState.mockResolvedValue(population);
    d.readInvoices.mockImplementation(async ({ invoiceIds }) => invoiceIds.map((invoiceId: string): InvoicePayableObservation =>
      invoiceId === "invoice-20" ? payable(invoiceId) : { kind: "settled", invoiceId, invoiceNumber: invoiceId, observedAt: "2026-07-01T00:00:00Z" }));
    const first = (await readBookingOutstandingAction("booking", "owner", undefined, d)).view;
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") throw new Error("missing first batch");
    expect(first.observations).toHaveLength(20); expect(hasOutstandingCollectionEvidence(first)).toBe(true);
    const last = (await readBookingOutstandingAction("booking", "owner", first.nextCursor!, d)).view;
    expect(last).toMatchObject({ nextCursor: null, observations: [payable("invoice-20")] });
    expect(d.readInvoices.mock.calls.map(([arg]) => arg.invoiceIds.length)).toEqual([20, 1]);
    const wrongActor = await readBookingOutstandingAction("booking", "other", first.nextCursor!, d);
    expect(wrongActor.view).toMatchObject({ incomplete: true, observations: [] });
    expect(d.readInvoices).toHaveBeenCalledTimes(2);
  });
});
