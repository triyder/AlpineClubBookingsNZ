import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("../_lib/booking-detail-outstanding", () => ({ readBookingOutstandingAction: vi.fn() }));
vi.mock("../_lib/booking-detail-history", () => ({ loadBookingDetailHistory: vi.fn() }));
vi.mock("../_lib/booking-detail-messages", () => ({ renderBookingDetailMessages: vi.fn(() => ({ paymentRequiredDescription: "Pay primary" })) }));
import { readBookingOutstandingAction } from "../_lib/booking-detail-outstanding";
import { loadBookingDetailHistory } from "../_lib/booking-detail-history";
import { renderBookingDetailMessages } from "../_lib/booking-detail-messages";
import { BookingStatusSection } from "../_components/booking-status-section";
import { bindClubFormat } from "@/lib/club-format-bound";
import { bindClubTime, requireClubTimeZone } from "@/lib/club-time";
import { resolveBookingNarrative } from "@/lib/booking-narrative";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
const club = bindClubTime(requireClubTimeZone("Pacific/Auckland"), CLUB_FORMAT_TEST);
const amountOwed = { owedCents: 5000, dueCents: 5000, appliedCreditCents: 0 };
const booking = { id: "booking", status: "CANCELLED", deletedAt: null, payment: null, memberId: "owner", member: { firstName: "Owner", lastName: "Proof" }, organisationId: null,
  adminReviewStatus: null, adminReviewNotes: null, adminReviewReason: null,
  organiserSettled: false, finalPriceCents: 5000, checkIn: new Date("2026-06-01T00:00:00Z"), checkOut: new Date("2026-06-02T00:00:00Z"),
  guests: [], linkedBookings: [], parentBooking: null, parentBookingId: null, groupBookingAsOrganiser: null, groupBookingJoin: null, refundRequests: [], creditsFromCancellation: [] };
const viewer = { isBookingOwner: true, canManageBooking: true, canSeeOwnerCredit: true, nonOwnerAdminViewer: false };
const props = () => ({ actorId: "owner", booking, club, money: bindClubFormat(CLUB_FORMAT_TEST), viewer, access: { isDeleted: false }, party: {},
  payment: { showCompletePaymentCard: true }, history: {}, messages: {}, modules: { xeroIntegration: true }, bookingMessages: {}, bookingLodgeEmailSettings: {} }) as never;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readBookingOutstandingAction).mockResolvedValue({ view: { kind: "hidden" }, state: { booking, viewer, format: CLUB_FORMAT_TEST, modules: { xeroIntegration: true } } } as never);
  vi.mocked(loadBookingDetailHistory).mockResolvedValue({ amountOwed, bookingNarrative: resolveBookingNarrative({ booking: { ...booking, firstName: "Owner", amountOwed }, events: [], club }, CLUB_FORMAT_TEST), moneyReconciliation: { visibility: "WITHHELD" } } as never);
});
describe("streamed status projections", () => {
  it("recomputes the primary pay prompt after cancellation during the provider wait", async () => {
    const html = renderToStaticMarkup(await BookingStatusSection(props()));
    expect(html).toContain("Booking cancelled"); expect(html).not.toContain("Payment required");
    expect(renderBookingDetailMessages).toHaveBeenCalledWith(expect.objectContaining({ payment: expect.objectContaining({ showCompletePaymentCard: false, amountDueAfterCreditCents: 5000 }) }));
  });
  it("uses amountless unavailable copy if current authority cannot be read", async () => {
    vi.mocked(readBookingOutstandingAction).mockRejectedValue(new Error("unavailable"));
    const html = renderToStaticMarkup(await BookingStatusSection(props()));
    expect(html).toContain("cannot yet be confirmed"); expect(html).not.toContain("No payment was required"); expect(html).not.toContain("Pay primary");
  });
  it.each([false, true])("feeds known/unknown additional evidence into the canonical narrative (unknown=%s)", async (incomplete) => {
    const completed = { ...booking, status: "COMPLETED" };
    vi.mocked(readBookingOutstandingAction).mockResolvedValue({ state: { booking: completed, viewer, format: CLUB_FORMAT_TEST, modules: { xeroIntegration: true } },
      view: { kind: "ready", audience: "owner", bookingStatus: "COMPLETED", revision: "revision", cardDueCents: 0, cardRevision: "card", incomplete, nextCursor: null,
        observations: incomplete ? [] : [{ kind: "payable", invoiceId: "extra", invoiceNumber: "INV-EXTRA", reference: null, dueCents: 1234, observedAt: "2026-07-01T00:00:00Z" }] } } as never);
    vi.mocked(loadBookingDetailHistory).mockImplementation(async ({ additionalCollectionPending }) => ({ amountOwed,
      bookingNarrative: resolveBookingNarrative({ booking: { ...completed, firstName: "Owner", amountOwed }, events: [], club, additionalCollectionPending }, CLUB_FORMAT_TEST), moneyReconciliation: { visibility: "WITHHELD" } }) as never);
    const html = renderToStaticMarkup(await BookingStatusSection(props()));
    expect(html).not.toContain("No payment was required"); expect(html).not.toContain("Nothing more to do");
    expect(loadBookingDetailHistory).toHaveBeenCalledWith(expect.objectContaining({ additionalCollectionPending: true }));
  });
});
