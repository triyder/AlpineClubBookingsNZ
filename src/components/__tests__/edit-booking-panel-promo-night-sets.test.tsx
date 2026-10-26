// @vitest-environment jsdom
/**
 * #4199: in grid mode the booking editor's promo box sends each guest the
 * nights the edit itself sends. A guest holding the 1st and 3rd of September
 * (a gap on the 2nd) and a second guest whose night the member switches off in
 * the grid: the promo preview's `guests[i].nights` must be the modification
 * payload's `guestStayRanges[i].nights`, guest for guest, after the toggle.
 *
 * Frozen clock discipline: September 2026 lodge nights, after the 2026-07-01
 * freeze; the edit policy's own `today` is fixed.
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@/lib/__tests__/support/club-time-render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const BOOKING_ID = "bk-4199";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const quoteBodies: Array<Record<string, unknown>> = [];
const validateBodies: Array<Record<string, unknown>> = [];

function installFetch() {
  quoteBodies.length = 0;
  validateBodies.length = 0;
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.includes("/api/members/family")) return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/api/promo-codes/guest-codes")) return jsonResponse({ multiPromoCodes: false, guests: [] });
    if (url.includes("/api/promo-codes/validate")) {
      validateBodies.push(body);
      return jsonResponse({ valid: false, error: "Promo code not found" }, 400);
    }
    if (url.includes("/modify-quote")) {
      quoteBodies.push(body);
      return jsonResponse({
        newTotalPriceCents: 15000,
        newDiscountCents: 0,
        newPromoAdjustmentCents: 0,
        newFinalPriceCents: 15000,
        priceDiffCents: 0,
        changeFeeCents: 0,
        netChargeCents: 0,
        settlementOptions: null,
        capacityAvailable: true,
        promoStillValid: true,
        promoCoverage: null,
        promoChangeNotApplied: null,
        promoValidation: null,
        itemizedChanges: [],
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function guest(id: string, firstName: string, nights: string[]) {
  return {
    id,
    firstName,
    lastName: "Hughes",
    ageTier: "ADULT",
    isMember: true,
    memberId: `member-${id}`,
    stayStart: "2026-09-01",
    stayEnd: "2026-09-04",
    nights,
    priceCents: 5000 * nights.length,
  };
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-04",
    guests: [
      // The gap that switches the grid on (#713).
      guest("g1", "Ann", ["2026-09-01", "2026-09-03"]),
      guest("g2", "Cal", ["2026-09-01", "2026-09-02", "2026-09-03"]),
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 25000,
    totalPriceCents: 25000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — the promo box sends the edit's nights (#4199)", () => {
  it("in grid mode, each guest's previewed nights are the payload's nights after a toggle", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    // Switch off one of Cal's nights in the grid (the grid is on: Ann has a gap).
    const calNights = await screen.findAllByRole("button", { name: /^Remove .* for Cal Hughes$/ });
    fireEvent.click(calNights[1]!);

    // The modification payload the quote (and the save) receive.
    await waitFor(() => expect(quoteBodies.length).toBeGreaterThan(0), { timeout: 2500 });
    const payload = quoteBodies.at(-1)! as { guestStayRanges: Array<{ guestId: string; nights: string[] }> };
    expect(payload.guestStayRanges.map((entry) => entry.nights)).toEqual([
      ["2026-09-01", "2026-09-03"],
      ["2026-09-01", "2026-09-03"],
    ]);

    // Apply a code in the promo box.
    fireEvent.change(await screen.findByPlaceholderText("Enter promo code"), { target: { value: "SAVE" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(validateBodies.length).toBe(1));

    const preview = validateBodies[0]! as {
      guests: Array<{ bookingGuestId?: string; nights?: string[] }>;
      checkIn: string;
      checkOut: string;
    };
    expect(preview.guests.map((g) => g.bookingGuestId)).toEqual(payload.guestStayRanges.map((entry) => entry.guestId));
    preview.guests.forEach((previewGuest, index) => {
      expect(previewGuest.nights).toEqual(payload.guestStayRanges[index]!.nights);
    });
  });
});
