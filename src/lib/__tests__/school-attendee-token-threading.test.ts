import { afterEach, describe, expect, it, vi } from "vitest";

// #1797: school-attendee-confirmation is now a registered (admin-editable)
// template. Its default body references {{token}} for the confirm link, so the
// sender MUST thread `token` into sendEmail's templateData — otherwise an admin
// override would render the confirm link blank. The render-path test drives
// sampleData, not the real sender, so this guards the actual behavioural fix.
vi.mock("@/lib/email/core", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

import { sendEmail } from "@/lib/email/core";
import { sendSchoolAttendeeConfirmationEmail } from "../email/booking-requests";

const mockedSendEmail = vi.mocked(sendEmail);

afterEach(() => {
  mockedSendEmail.mockClear();
});

describe("school-attendee confirmation threads its confirm-link token (#1797)", () => {
  it("passes the raw token in templateData so an override renders the link", async () => {
    await sendSchoolAttendeeConfirmationEmail({
      email: "coordinator@school.example",
      firstName: "Sam",
      schoolName: "Example School",
      token: "tok-abc123",
      checkIn: new Date("2026-08-01"),
      checkOut: new Date("2026-08-03"),
      guestCount: 12,
      isReminder: false,
    });

    expect(mockedSendEmail).toHaveBeenCalledTimes(1);
    const call = mockedSendEmail.mock.calls[0][0];
    expect(call.templateName).toBe("school-attendee-confirmation");
    // The required body token {{token}} must be supplied and equal the raw
    // token, so `{{BASE_URL}}/school-bookings/confirm/{{token}}` renders whole.
    expect(call.templateData?.token).toBe("tok-abc123");
  });
});
