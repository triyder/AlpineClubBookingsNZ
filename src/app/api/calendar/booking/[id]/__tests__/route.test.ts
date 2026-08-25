import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sessionless .ics download (fork issue #35).
 *
 * An unauthenticated endpoint whose whole security story is the HMAC token
 * check, so that check is what gets tested: a valid token serves exactly one
 * booking's stay as text/calendar; a wrong-booking token, a missing token,
 * and a gone booking are all the same 404.
 */

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { booking: { findUnique: mocks.findUnique } },
}));

import { GET } from "@/app/api/calendar/booking/[id]/route";
import { bookingCalendarToken } from "@/lib/calendar-links";
import { parseDateOnly } from "@/lib/date-only";

const BOOKING_ID = "bkg_route_test";

function requestFor(token: string | null): NextRequest {
  const url = new URL(
    `https://bookings.example.org/api/calendar/booking/${BOOKING_ID}`,
  );
  if (token !== null) url.searchParams.set("token", token);
  return new NextRequest(url);
}

function call(token: string | null, id = BOOKING_ID) {
  return GET(requestFor(token), { params: Promise.resolve({ id }) });
}

const SERVABLE_BOOKING = {
  checkIn: parseDateOnly("2026-08-01"),
  checkOut: parseDateOnly("2026-08-04"),
  status: "CONFIRMED",
  deletedAt: null,
  lodge: { name: "Example Lodge" },
};

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", "calendar-route-test-secret");
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.org");
  mocks.findUnique.mockReset();
  mocks.findUnique.mockResolvedValue(SERVABLE_BOOKING);
});

describe("GET /api/calendar/booking/[id]", () => {
  it("serves the stay as an attachment with a valid token", async () => {
    const response = await call(bookingCalendarToken(BOOKING_ID));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="lodge-stay.ics"',
    );
    const body = await response.text();
    expect(body).toContain("DTSTART;VALUE=DATE:20260801");
    expect(body).toContain("DTEND;VALUE=DATE:20260805");
    expect(body).toContain("SUMMARY:Example Lodge stay");
  });

  it("404s with no token, without touching the database", async () => {
    const response = await call(null);
    expect(response.status).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s with another booking's token, without touching the database", async () => {
    const response = await call(bookingCalendarToken("bkg_other"));
    expect(response.status).toBe(404);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("404s for a booking that no longer exists", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const response = await call(bookingCalendarToken(BOOKING_ID));
    expect(response.status).toBe(404);
  });

  it.each(["CANCELLED", "BUMPED", "DRAFT", "WAITLISTED", "WAITLIST_OFFERED"])(
    "404s for a %s booking — a stay that no longer stands must not reach a calendar",
    async (status) => {
      mocks.findUnique.mockResolvedValue({ ...SERVABLE_BOOKING, status });
      const response = await call(bookingCalendarToken(BOOKING_ID));
      expect(response.status).toBe(404);
    },
  );

  it("404s for a soft-deleted booking", async () => {
    mocks.findUnique.mockResolvedValue({
      ...SERVABLE_BOOKING,
      deletedAt: new Date(),
    });
    const response = await call(bookingCalendarToken(BOOKING_ID));
    expect(response.status).toBe(404);
  });

  it.each(["PAID", "COMPLETED", "PENDING", "PAYMENT_PENDING", "AWAITING_REVIEW"])(
    "still serves a %s booking — the stay stands even as status advances",
    async (status) => {
      mocks.findUnique.mockResolvedValue({ ...SERVABLE_BOOKING, status });
      const response = await call(bookingCalendarToken(BOOKING_ID));
      expect(response.status).toBe(200);
    },
  );
});
