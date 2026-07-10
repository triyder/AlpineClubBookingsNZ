import { describe, expect, it } from "vitest";
import {
  BOOKING_ACCENTS,
  getBookingAccent,
} from "@/app/(admin)/admin/bed-allocation/_components/booking-accent";

describe("bed allocation booking accents", () => {
  it("maps the same booking id to the same accent", () => {
    expect(getBookingAccent("booking-123")).toEqual(
      getBookingAccent("booking-123"),
    );
  });

  it("uses the fixed accent palette", () => {
    const accents = new Set(
      Array.from({ length: 32 }, (_, index) =>
        getBookingAccent(`booking-${index}`).stripClassName,
      ),
    );

    expect(accents.size).toBeGreaterThan(1);
    expect(accents.size).toBeLessThanOrEqual(BOOKING_ACCENTS.length);
    expect(BOOKING_ACCENTS).toContain(getBookingAccent("booking-123"));
  });

  it("returns reusable strip, ring, and tint classes for both themes", () => {
    expect(BOOKING_ACCENTS).toHaveLength(9);
    for (const accent of BOOKING_ACCENTS) {
      expect(accent.name).toBeTruthy();
      expect(accent.stripClassName).toMatch(/^bg-[a-z]+-500$/);
      expect(accent.ringClassName).toMatch(/^ring-[a-z]+-200 /);
      expect(accent.ringClassName).toMatch(/\bdark:ring-[a-z]+-800\/60\b/);
      expect(accent.tintClassName).toMatch(/^bg-[a-z]+-50\/45 /);
      expect(accent.tintClassName).toMatch(/\bdark:bg-[a-z]+-950\/20\b/);
    }
  });
});
