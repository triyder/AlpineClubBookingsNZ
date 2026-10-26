// @vitest-environment jsdom

/**
 * #4197: a refused promo code keeps the booking's stored promotion in the
 * preview's totals (the save refuses the whole edit, so that is what it would
 * leave). The refusal itself must still reach the member, and it does so only
 * through `promoValidation.error` on the promo card - pinned here so keeping
 * the stored figures can never silently hide it.
 */
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it, vi } from "vitest";
import { PromoCodeCard } from "@/components/edit-booking/promo-code-card";
import type { QuoteResult } from "@/components/edit-booking/types";

vi.mock("@/components/promo-code-list-client", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/promo-code-list-client")),
  // The one-code card: the club runs one code per booking.
  useGuestPromoCodes: () => ({ multiPromoCodes: false, groups: [], status: "ready" }),
}));
// The entry widgets fetch on their own; they are not what is under test.
vi.mock("@/components/promo-code-input", async (importOriginal) => ({
  ...((await importOriginal()) as typeof import("@/components/promo-code-input")),
  PromoCodeInput: () => null,
}));
vi.mock("@/components/promo-code-chips", () => ({ PromoCodeChips: () => null }));

const noop = () => {};

describe("PromoCodeCard — a refused code (#4197)", () => {
  it("shows the refusal while the quote keeps the stored promotion", () => {
    const quote = {
      newPromoAdjustmentCents: -2_500,
      newDiscountCents: 2_500,
      itemizedChanges: [],
      promoValidation: { valid: false, error: "Promo code not found" },
    } as unknown as QuoteResult;

    render(
      <PromoCodeCard
        bookingId="b1"
        promo={{ code: "SPRING10", type: "PERCENTAGE", description: null }}
        appliedPromoList={null}
        onPromoListChange={noop}
        onKeepPromoList={noop}
        promoAdjustmentCents={-2_500}
        promoAction={{ type: "new", code: "NOPE" }}
        availablePromoCodes={[]}
        appliedNewPromo={null}
        prefillPromoCode={undefined}
        guestStays={{ checkIn: "2026-08-14", checkOut: "2026-08-16", existing: null, added: [] }}
        remainingGuests={[]}
        addedGuests={[]}
        quote={quote}
        forMemberId={undefined}
        lodgeId={null}
        editRerates={{}}
        onRemovePromo={noop}
        onKeepPromo={noop}
        onPrefillCode={noop}
        onPromoApplied={noop}
      />,
    );

    expect(screen.getByText("Promo code not found")).toBeTruthy();
  });
});
