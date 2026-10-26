import { describe, expect, it } from "vitest";
import { bookingOutstandingCardCents } from "@/lib/booking-outstanding-payment";
describe("member outstanding card authority (INV-ADDPAY-023)", () => {
  const booking = { status: "PAYMENT_PENDING", deletedAt: null, organiserSettled: false, payment: { additionalAmountCents: 1234, additionalPaymentStatus: "PENDING" } };
  it.each(["PAYMENT_PENDING", "CONFIRMED", "PAID", "COMPLETED"])("keeps the member door on %s", (status) => expect(bookingOutstandingCardCents({ ...booking, status })).toBe(1234));
  it.each(["CANCELLED", "BUMPED", "DRAFT", "PENDING"])("excludes %s", (status) => expect(bookingOutstandingCardCents({ ...booking, status })).toBe(0));
  it("excludes collected/deleted asks and preserves the canonical member door on an organiser-settled booking", () => {
    expect(bookingOutstandingCardCents({ ...booking, payment: { ...booking.payment, additionalPaymentStatus: "SUCCEEDED" } })).toBe(0);
    expect(bookingOutstandingCardCents({ ...booking, deletedAt: new Date("2026-06-01T00:00:00Z") })).toBe(0);
    const organiserBooking = { ...booking, organiserSettled: true };
    expect(bookingOutstandingCardCents(organiserBooking)).toBe(1234);
  });
});
