// @vitest-environment jsdom
/**
 * #4199: the booking editor's promo box sends each guest's chosen nights, so the
 * preview prices the nights the quote and the save price. It used to send a
 * grid guest's Date In and Date Out — or nothing — and the box discounted the
 * gap night the guest does not hold.
 *
 * Frozen clock discipline: every date is a fixed August 2026 lodge night.
 */
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PromoCodeCard } from "@/components/edit-booking/promo-code-card";
import { buildEditGuestStays } from "@/components/edit-booking/guest-stay-payload";
import type { Guest, NewGuest } from "@/components/edit-booking/types";

const booking = { checkIn: "2026-08-10", checkOut: "2026-08-13" };
const gapped: Guest = {
  id: "bg-gap",
  firstName: "Gap",
  lastName: "Guest",
  ageTier: "ADULT",
  isMember: true,
  memberId: "member-1",
  stayStart: "2026-08-10",
  stayEnd: "2026-08-13",
  nights: ["2026-08-10", "2026-08-12"],
  priceCents: 0,
};
const added: NewGuest = {
  key: "k1",
  firstName: "New",
  lastName: "Guest",
  ageTier: "ADULT",
  isMember: false,
  nights: ["2026-08-11"],
};

function stays(mode: { multiDateRangesEnabled: boolean; perGuestDatesEnabled: boolean }) {
  return buildEditGuestStays({
    ...mode,
    isInProgressEdit: false,
    booking,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    remainingGuests: [gapped],
    addedGuests: [added],
    existingGuestNights: { "bg-gap": ["2026-08-10", "2026-08-12"] },
    getExistingGuestRange: () => ({ stayStart: "2026-08-10", stayEnd: "2026-08-13" }),
  });
}

/** Answer the guest-code lookup "one code only", then capture the validate call. */
function stubFetch() {
  const fetchMock = vi.fn(async (url: string) =>
    url.includes("/api/promo-codes/validate")
      ? new Response(JSON.stringify({ valid: false, error: "Promo code not found" }), { status: 400 })
      : new Response(JSON.stringify({ multiPromoCodes: false, guests: [] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function applyCode(guestStays: ReturnType<typeof stays>) {
  const fetchMock = stubFetch();
  render(
    <PromoCodeCard
      bookingId="booking-1"
      promo={null}
      appliedPromoList={null}
      onPromoListChange={vi.fn()}
      onKeepPromoList={vi.fn()}
      promoAdjustmentCents={0}
      promoAction={{ type: "keep" }}
      availablePromoCodes={[]}
      appliedNewPromo={null}
      prefillPromoCode={undefined}
      guestStays={guestStays}
      remainingGuests={[gapped]}
      addedGuests={[added]}
      quote={null}
      forMemberId={undefined}
      lodgeId="lodge-1"
      editRerates={{}}
      onRemovePromo={vi.fn()}
      onKeepPromo={vi.fn()}
      onPrefillCode={vi.fn()}
      onPromoApplied={vi.fn()}
    />,
  );
  fireEvent.change(await screen.findByPlaceholderText("Enter promo code"), { target: { value: "SAVE" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/promo-codes/validate"))).toBe(true),
  );
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/promo-codes/validate"))!;
  return JSON.parse(String((call as unknown as [string, RequestInit])[1].body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the booking editor's promo box (#4199)", () => {
  it("sends each guest's night set in grid mode", async () => {
    const body = await applyCode(stays({ multiDateRangesEnabled: true, perGuestDatesEnabled: false }));
    expect(body.guests).toEqual([
      {
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-1",
        nights: ["2026-08-10", "2026-08-12"],
        bookingGuestId: "bg-gap",
      },
      { ageTier: "ADULT", isMember: false, nights: ["2026-08-11"] },
    ]);
    expect(body.checkIn).toBe("2026-08-10");
    expect(body.checkOut).toBe("2026-08-13");
    expect(body.bookingId).toBe("booking-1");
  });

  it("sends continuous dates in range mode, unchanged (#4189)", async () => {
    const body = await applyCode(stays({ multiDateRangesEnabled: false, perGuestDatesEnabled: true }));
    expect(body.guests[0]).toEqual({
      ageTier: "ADULT",
      isMember: true,
      memberId: "member-1",
      stayStart: "2026-08-10",
      stayEnd: "2026-08-13",
      bookingGuestId: "bg-gap",
    });
    expect(body.guests[0].nights).toBeUndefined();
  });
});
