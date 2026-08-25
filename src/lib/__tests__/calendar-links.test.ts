import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  bookingAddToCalendarBlock,
  bookingCalendarLinks,
  bookingCalendarToken,
  bookingIcsDownloadUrl,
  buildBookingIcs,
  googleCalendarUrl,
  outlookCalendarUrl,
  verifyBookingCalendarToken,
} from "@/lib/calendar-links";
import { parseDateOnly } from "@/lib/date-only";
import { sampleValue } from "@/lib/email-message-registry";

/**
 * The add-to-calendar links for a booking's stay (fork issue #35).
 *
 * A stay is an NZ date-only night range (INV-DATE-001), so the one invariant
 * every format must hold is ALL-DAY dates with an EXCLUSIVE end of
 * checkout + 1 day — an event that spans check-in through the checkout day
 * and never mentions a time or a zone.
 */

// The stay used throughout: 3 nights, 1–4 Aug 2026 (future under the frozen
// test clock, 2026-07-01). All-day exclusive end = 5 Aug.
const STAY = {
  bookingId: "bkg_test123",
  checkIn: parseDateOnly("2026-08-01"),
  checkOut: parseDateOnly("2026-08-04"),
};
const LODGE = "Example Lodge";

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "calendar-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.org");
});

describe("bookingCalendarToken", () => {
  it("verifies its own token and is stable per booking id", () => {
    const token = bookingCalendarToken(STAY.bookingId);
    expect(token).toBe(bookingCalendarToken(STAY.bookingId));
    expect(verifyBookingCalendarToken(STAY.bookingId, token)).toBe(true);
  });

  it("rejects a token for a different booking, a truncated token, and garbage", () => {
    const token = bookingCalendarToken(STAY.bookingId);
    expect(verifyBookingCalendarToken("bkg_other", token)).toBe(false);
    expect(verifyBookingCalendarToken(STAY.bookingId, token.slice(0, -1))).toBe(
      false,
    );
    expect(verifyBookingCalendarToken(STAY.bookingId, "not-a-token")).toBe(
      false,
    );
  });

  it("changes when the secret changes, so a token cannot outlive a rotated secret", () => {
    const token = bookingCalendarToken(STAY.bookingId);
    vi.stubEnv("AUTH_SECRET", "rotated-secret");
    expect(verifyBookingCalendarToken(STAY.bookingId, token)).toBe(false);
  });

  it("throws without an auth secret rather than signing with nothing", () => {
    vi.stubEnv("AUTH_SECRET", "");
    vi.stubEnv("NEXTAUTH_SECRET", "");
    expect(() => bookingCalendarToken(STAY.bookingId)).toThrow(/AUTH_SECRET/);
  });
});

describe("buildBookingIcs", () => {
  it("renders an all-day VEVENT spanning check-in through the checkout day (exclusive end)", () => {
    const ics = buildBookingIcs({
      stay: STAY,
      lodgeName: LODGE,
      generatedAt: new Date(),
    });
    // The frozen test clock makes DTSTAMP deterministic.
    expect(ics).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//AlpineClubBookingsNZ//Booking Calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        "UID:booking-bkg_test123@bookings.example.org",
        "DTSTAMP:20260701T000000Z",
        "DTSTART;VALUE=DATE:20260801",
        "DTEND;VALUE=DATE:20260805",
        "SUMMARY:Example Lodge stay",
        "LOCATION:Example Lodge",
        "DESCRIPTION:Lodge booking from 2026-08-01 to checkout. Manage your booking",
        " : https://bookings.example.org/bookings",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("escapes RFC 5545 TEXT characters in the lodge name", () => {
    const ics = buildBookingIcs({
      stay: STAY,
      lodgeName: "Ruapehu; North, Lodge",
      generatedAt: new Date(),
    });
    expect(ics).toContain("SUMMARY:Ruapehu\\; North\\, Lodge stay");
  });

  it("keeps a stable UID per booking so re-imports update rather than duplicate", () => {
    const first = buildBookingIcs({
      stay: STAY,
      lodgeName: LODGE,
      generatedAt: new Date(),
    });
    const second = buildBookingIcs({
      stay: { ...STAY, checkOut: parseDateOnly("2026-08-06") },
      lodgeName: LODGE,
      generatedAt: new Date(),
    });
    const uidOf = (ics: string) =>
      ics.split("\r\n").find((line) => line.startsWith("UID:"));
    expect(uidOf(first)).toBe(uidOf(second));
  });
});

describe("web calendar URLs", () => {
  it("Google uses compact all-day dates with the exclusive end", () => {
    const url = new URL(googleCalendarUrl({ stay: STAY, lodgeName: LODGE }));
    expect(url.origin + url.pathname).toBe(
      "https://calendar.google.com/calendar/render",
    );
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("dates")).toBe("20260801/20260805");
    expect(url.searchParams.get("text")).toBe("Example Lodge stay");
  });

  it("Outlook uses allday=true with ISO dates and the exclusive end", () => {
    const url = new URL(outlookCalendarUrl({ stay: STAY, lodgeName: LODGE }));
    expect(url.origin + url.pathname).toBe(
      "https://outlook.live.com/calendar/0/deeplink/compose",
    );
    expect(url.searchParams.get("allday")).toBe("true");
    expect(url.searchParams.get("startdt")).toBe("2026-08-01");
    expect(url.searchParams.get("enddt")).toBe("2026-08-05");
  });

  it("the .ics download URL carries the booking's own verifiable token", () => {
    const url = new URL(bookingIcsDownloadUrl(STAY.bookingId));
    expect(url.pathname).toBe("/api/calendar/booking/bkg_test123");
    expect(
      verifyBookingCalendarToken(
        STAY.bookingId,
        url.searchParams.get("token") ?? "",
      ),
    ).toBe(true);
  });
});

describe("the {{ical}} block", () => {
  it("composes the three links as complete lines", () => {
    const links = bookingCalendarLinks({ stay: STAY, lodgeName: LODGE });
    const block = bookingAddToCalendarBlock(links);
    const lines = block.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("Add this stay to your calendar");
    expect(lines[1]).toBe(`Calendar file (.ics): ${links.icsUrl}`);
    expect(lines[2]).toBe(`Google Calendar: ${links.googleUrl}`);
    expect(lines[3]).toBe(`Outlook: ${links.outlookUrl}`);
  });

  it("the editor preview sample is the composer's own shape (stale-sample guard)", () => {
    // The registry hard-codes the sample (it cannot compose — composing needs
    // the HMAC secret and the registry is editor-facing), so this equality is
    // what keeps the preview honest when the composer's wording changes.
    expect(sampleValue("ical")).toBe(
      bookingAddToCalendarBlock({
        icsUrl:
          "https://bookings.example.org/api/calendar/booking/bkg_example?token=sample",
        googleUrl:
          "https://calendar.google.com/calendar/render?action=TEMPLATE&text=Example+Lodge+stay&dates=20260801/20260806",
        outlookUrl:
          "https://outlook.live.com/calendar/0/deeplink/compose?rru=addevent&allday=true&startdt=2026-08-01&enddt=2026-08-06",
      }),
    );
  });
});
