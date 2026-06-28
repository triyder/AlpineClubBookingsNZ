import { describe, expect, it } from "vitest";
import {
  BOOKING_MESSAGE_DEFINITION_BY_KEY,
  extractBookingMessageTokens,
  renderBookingMessageTemplate,
  validateBookingMessageContent,
} from "@/lib/booking-message-definitions";

describe("booking message definitions", () => {
  it("keeps the Internet Banking payment method default explicit about Xero and unheld bookings", () => {
    expect(
      BOOKING_MESSAGE_DEFINITION_BY_KEY.get(
        "booking.payment.internetBanking.description",
      )?.defaultBody,
    ).toBe(
      "Receive a Xero invoice by email and make payment via internet banking. Once the payment is reconciled and sync'd back to the booking system, your booking will be confirmed. Until then your booking is not held and someone else could take your space by booking and paying with Card.",
    );
  });

  it("renders known merge fields and blanks missing fields", () => {
    expect(
      renderBookingMessageTemplate(
        "Hi {{ bookerFirstName }}, pay {{amountDue}} using {{paymentReference}} {{missingKnown}}.",
        {
          bookerFirstName: "Sam",
          amountDue: "$120.00",
          paymentReference: "BOOK-123",
        },
      ),
    ).toBe("Hi Sam, pay $120.00 using BOOK-123 .");
  });

  it("extracts merge fields from templates", () => {
    expect(
      extractBookingMessageTokens("{{bookerFirstName}} {{ amountDue }} {{amountDue}}"),
    ).toEqual(["bookerFirstName", "amountDue"]);
  });

  it("rejects HTML and unknown merge fields", () => {
    expect(validateBookingMessageContent("<strong>Hello</strong>").ok).toBe(false);

    const result = validateBookingMessageContent("Hello {{unknownField}}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("unknownField");
    }
  });
});
