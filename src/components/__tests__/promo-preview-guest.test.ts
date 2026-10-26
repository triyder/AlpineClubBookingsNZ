/**
 * #4199: every promo preview sends a guest's night set, through one request
 * shape. The create wizard's code list in grid mode sends nights only (its
 * contiguous range is dropped, #713), so before this the preview priced that
 * guest on the whole booking.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { promoPreviewGuestBody } from "@/components/promo-preview-guest";
import { validatePromoCodeList } from "@/components/promo-code-list-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("promoPreviewGuestBody", () => {
  it("carries a night set, and a row id only beside a booking id", () => {
    const guest = {
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      nights: ["2026-08-10", "2026-08-12"],
      bookingGuestId: "bg-1",
    };
    expect(promoPreviewGuestBody(guest)).toEqual({
      ageTier: "ADULT",
      isMember: true,
      memberId: "m1",
      nights: ["2026-08-10", "2026-08-12"],
    });
    expect(promoPreviewGuestBody(guest, { bookingId: "b1" })).toMatchObject({ bookingGuestId: "bg-1" });
  });

  it("sends no empty night set", () => {
    expect(promoPreviewGuestBody({ ageTier: "ADULT", isMember: false, nights: [] })).toEqual({
      ageTier: "ADULT",
      isMember: false,
    });
  });
});

describe("the several-code preview (create wizard, Book on Behalf)", () => {
  it("sends each guest's night set", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ valid: true, codes: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await validatePromoCodeList({
      entries: [{ code: "SAVE" }],
      checkIn: "2026-08-10",
      checkOut: "2026-08-13",
      guests: [{ ageTier: "ADULT", isMember: true, memberId: "m1", nights: ["2026-08-10", "2026-08-12"] }],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).guests).toEqual([
      { ageTier: "ADULT", isMember: true, memberId: "m1", nights: ["2026-08-10", "2026-08-12"] },
    ]);
  });
});
