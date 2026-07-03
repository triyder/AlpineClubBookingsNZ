import { expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import {
  bookSelfToReviewStep,
  confirmBookingToPaymentStep,
  fetchOccupiedBeds,
  selectCalendarDay,
} from "./helpers/booking";
import { personas } from "./helpers/personas";
import { stayWindow } from "./helpers/stay-dates";

// Critical row: member books a bed through /book with the capacity lock.
// The persona signed in by auth.setup.ts creates a real booking through the
// full wizard. Capacity semantics under test follow issue #737: a booking
// that still owes payment holds NO bed (only committed money reserves
// capacity — see CAPACITY_HOLDING_BOOKING_STATUSES), while the member-night
// lock still blocks the same member from booking the same lodge night twice.
// The paid-booking occupancy delta is asserted in stripe-payment.spec.ts,
// where a test-mode payment can actually commit the money.
test.use({ storageState: storageStatePath(personas.booker.email) });

test.describe.configure({ mode: "serial" });

const window = stayWindow(0);

test("member books a bed through /book and the booking owes payment", async ({
  page,
}) => {
  const occupiedBefore = await fetchOccupiedBeds(page, window.nights);

  await bookSelfToReviewStep(page, personas.booker, window);
  await confirmBookingToPaymentStep(page);

  // Issue #737: no money committed yet, so the payment-pending booking must
  // not consume lodge capacity.
  const occupiedAfter = await fetchOccupiedBeds(page, window.nights);
  for (const night of window.nights) {
    expect(
      occupiedAfter[night],
      `occupied beds on ${night} while payment is owed`,
    ).toBe(occupiedBefore[night]);
  }

  // The booking is visible to the member with payment still owed.
  await page.goto("/bookings");
  const checkInDay = String(Number(window.checkIn.split("-")[2]));
  await expect(
    page.getByText(new RegExp(`\\b${checkInDay}[/ ]`)).first(),
  ).toBeVisible();
  await expect(page.getByText(/payment/i).first()).toBeVisible();
});

test("the same member cannot hold the same lodge night twice", async ({
  page,
}) => {
  await page.goto("/book");

  await expect(page.getByText("Select Your Dates")).toBeVisible();
  // Re-select the window already booked in the previous test.
  await selectCalendarDay(page, window.checkIn);
  await selectCalendarDay(page, window.checkOut);

  await expect(page.getByText("Add Guests")).toBeVisible();
  const addSelf = page.getByRole("button", {
    name: `+ ${personas.booker.firstName} ${personas.booker.lastName} (You)`,
  });

  // The wizard must refuse to carry the member into a second live booking on
  // the same nights: either the quick-add is blocked outright or continuing
  // surfaces a conflict message instead of a quote.
  if (await addSelf.isEnabled().catch(() => false)) {
    await addSelf.click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByText(/already (booked|has a booking|have a booking|part of)/i).first(),
    ).toBeVisible();
    await expect(page.getByText("Booking Summary")).not.toBeVisible();
  } else {
    await expect(addSelf).toBeDisabled();
  }
});
