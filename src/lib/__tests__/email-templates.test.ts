import { describe, it, expect, vi } from "vitest";
import {
  passwordResetTemplate,
  bookingConfirmedTemplate,
  bookingPendingTemplate,
  bookingBumpedTemplate,
  bookingCancelledTemplate,
  choreRosterTemplate,
  hutLeaderAssignmentTemplate,
  adminDailyDigestTemplate,
  adminPendingDeadlineTemplate,
  adminIssueReportTemplate,
  adminRefundRequestTemplate,
  adminDuplicateCaptureRefundTemplate,
  preArrivalReminderTemplate,
  waitlistOfferTemplate,
  adminSplitSettlementUnpaidTemplate,
  adminSplitSettlementCancelledTemplate,
  splitGuestPortionCancelledTemplate,
} from "../email-templates";
import { getAppBaseUrl } from "../app-url";
import { formatNZDateTime } from "../nzst-date";
import {
  AA_TEXT_CONTRAST_RATIO,
  DEFAULT_CLUB_THEME_VALUES,
  contrastRatio,
  deriveBrandShims,
} from "../club-theme-schema";

describe("email-templates", () => {
  describe("adminDailyDigestTemplate", () => {
    it("uses dark text on light table headers", () => {
      const html = adminDailyDigestTemplate({
        newBookings: 1,
        paymentFailures: 0,
        capacityWarnings: 0,
        bookingsBumped: 0,
        pendingDeadlines: 0,
        xeroErrors: 0,
        totalAlerts: 1,
      });

      // The email palette is DERIVED from the substrate (#2187): the header fill
      // is the neutral-3 "mist" step and the ink is the "deep" seed. Pin the
      // header style to the COMPUTED shipping derivation, never a stale literal,
      // so it tracks the generator instead of a hand-copied hex.
      const { mist, deep, gold } = deriveBrandShims(DEFAULT_CLUB_THEME_VALUES);
      expect(html).toContain(`background-color: ${mist}; color: ${deep};`);
      // Never the accent (gold) as header ink — that was the low-contrast bug.
      expect(html).not.toContain(`background-color: ${mist}; color: ${gold};`);

      // Intent: dark ink on a light header clears WCAG AA for the header fill.
      const ratio = contrastRatio(deep, mist);
      expect(ratio).not.toBeNull();
      expect(ratio as number).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST_RATIO);
    });
  });

  describe("adminDuplicateCaptureRefundTemplate (#1992 / #2007)", () => {
    const base = {
      memberName: "Alice Member",
      checkIn: new Date("2026-08-10"),
      checkOut: new Date("2026-08-12"),
      amountCents: 10000,
      paymentIntentId: "pi_link_intent",
      settledPaymentIntentId: "pi_auto_charge",
      operationReference: "duplicate_capture_booking-1_pi_link_intent",
      reviewUrl: "https://example.com/admin/payments",
    };

    it("success variant states the duplicate was refunded in full and needs no action", () => {
      const html = adminDuplicateCaptureRefundTemplate({
        ...base,
        refundFailed: false,
      });
      expect(html).toContain("Duplicate Card Capture Auto-Refunded");
      expect(html).toContain("automatically refunded in full");
      expect(html).toContain("no action is needed");
      // Booking/member/amount/intent context is carried.
      expect(html).toContain("Alice Member");
      expect(html).toContain("pi_link_intent");
      expect(html).toContain("pi_auto_charge");
      expect(html).toContain("duplicate_capture_booking-1_pi_link_intent");
      // Not the failed wording.
      expect(html).not.toContain("could not complete");
      expect(html).not.toContain("Retry Queued");
    });

    it("failed variant states the refund could not complete and a durable retry is queued, with the op reference and failure detail", () => {
      const html = adminDuplicateCaptureRefundTemplate({
        ...base,
        refundFailed: true,
        errorMessage: "Stripe is unavailable (503)",
      });
      expect(html).toContain("Retry Queued");
      expect(html).toContain("could not be automatically refunded");
      expect(html).toContain("watch the recovery queue");
      // Op reference and the inline failure detail are surfaced.
      expect(html).toContain("duplicate_capture_booking-1_pi_link_intent");
      expect(html).toContain("Stripe is unavailable (503)");
      // Not the success wording.
      expect(html).not.toContain("no action is needed");
    });

    it("falls back to 'another capture' when the settling intent id is unknown", () => {
      const html = adminDuplicateCaptureRefundTemplate({
        ...base,
        settledPaymentIntentId: null,
        refundFailed: false,
      });
      expect(html).toContain("another capture");
    });
  });

  describe("adminSplitSettlementUnpaidTemplate (#1993)", () => {
    const base = {
      memberName: "Jane Doe",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guestCount: 2,
      totalCents: 12000,
      holdUntil: new Date("2026-07-11T12:00:00.000Z"),
      reviewUrl: "https://example.com/admin/bookings",
      parentUnpaid: false,
    };

    it("recurring variant reports the hold extension and the capped repeating cadence", () => {
      const html = adminSplitSettlementUnpaidTemplate(base);
      expect(html).toContain("Hold extended to");
      // #1993 Part B / C3: the cadence is capped (1, 2, 3, then every 7th) and a
      // terminal cancellation ends the series — no more "repeats each run".
      expect(html).toContain("capped cadence");
      expect(html).toContain("first three hold extensions");
      expect(html).not.toContain("This alert repeats each time the hold is extended");
      expect(html).not.toContain("automatically cancelled");
    });

    it("recurring variant distinguishes parent-unpaid wording", () => {
      const settled = adminSplitSettlementUnpaidTemplate({
        ...base,
        parentUnpaid: false,
      });
      const parentUnpaid = adminSplitSettlementUnpaidTemplate({
        ...base,
        parentUnpaid: true,
      });
      expect(settled).toContain("internet banking");
      expect(parentUnpaid).toContain("has not been paid either");
    });
  });

  describe("adminSplitSettlementCancelledTemplate (#1993 Part A, C1)", () => {
    const base = {
      memberName: "Jane Doe",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      guestCount: 2,
      totalCents: 12000,
      reviewUrl: "https://example.com/admin/bookings",
      parentUnpaid: false,
    };

    it("reports the auto-cancellation and drops any hold/repeat wording", () => {
      const html = adminSplitSettlementCancelledTemplate(base);
      expect(html).toContain("Auto-Cancelled");
      expect(html).toContain("automatically cancelled");
      // A terminal one-off notice: no "hold extended" row, no recurring cadence.
      expect(html).not.toContain("Hold extended to");
      expect(html).not.toContain("capped cadence");
      expect(html).toContain("one-off notice");
    });

    it("states the parent's actual state accurately (never a false 'also unpaid')", () => {
      const settled = adminSplitSettlementCancelledTemplate({
        ...base,
        parentUnpaid: false,
      });
      const parentUnpaid = adminSplitSettlementCancelledTemplate({
        ...base,
        parentUnpaid: true,
      });
      expect(settled).toContain("internet banking");
      expect(settled).toContain("settled and is unaffected");
      // For a not-settled parent the copy says "not settled (it may be unpaid or
      // already cancelled)" rather than asserting it is specifically unpaid.
      expect(parentUnpaid).toContain("not settled either");
      expect(parentUnpaid).toContain("already cancelled");
    });
  });

  describe("splitGuestPortionCancelledTemplate (#1993 Part A, C2)", () => {
    const base = {
      firstName: "Sam",
      checkIn: new Date("2026-07-01"),
      checkOut: new Date("2026-07-03"),
      parentConfirmed: true,
    };

    it("reassures nothing was charged and only the guest portion was cancelled", () => {
      const html = splitGuestPortionCancelledTemplate(base);
      expect(html).toContain("Your Guests' Provisional Place Was Cancelled");
      expect(html).toContain("Nothing was ever charged");
      expect(html).toContain("your own booking is unaffected and remains confirmed");
    });

    it("does not promise 'remains confirmed' when the parent is not settled", () => {
      const html = splitGuestPortionCancelledTemplate({
        ...base,
        parentConfirmed: false,
      });
      expect(html).not.toContain("remains confirmed");
      expect(html).toContain("has not been changed by this cancellation");
    });

    it("shows the member's own booking reference when available", () => {
      const html = splitGuestPortionCancelledTemplate({
        ...base,
        parentBookingReference: "parent_abc",
      });
      expect(html).toContain("Your booking reference");
      expect(html).toContain("parent_abc");
    });
  });

  describe("passwordResetTemplate", () => {
    it("includes the reset URL", () => {
      const html = passwordResetTemplate("https://example.com/reset?token=abc");
      expect(html).toContain("https://example.com/reset?token=abc");
    });

    it("mentions expiry time", () => {
      const html = passwordResetTemplate("https://example.com/reset");
      expect(html).toContain("1 hour");
    });
  });

  describe("bookingConfirmedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes booking details", () => {
      const html = bookingConfirmedTemplate("Alice", checkIn, checkOut, 3, 45000);
      expect(html).toContain("Alice");
      expect(html).toContain("3");
      expect(html).toContain("$450.00");
    });

    it("shows confirmed status", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("Booking Confirmed");
    });

    it("includes view booking link", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000);
      expect(html).toContain("/bookings");
    });

    it("includes lodge directions and the configured door code", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000, {
        lodgeTravelNote: "Take the Bruce Road and carry chains.",
        doorCode: "A1234",
      });

      expect(html).toContain("How to get to the lodge");
      expect(html).toContain("Take the Bruce Road and carry chains.");
      expect(html).toContain("Door code");
      expect(html).toContain("A1234");
    });

    it("includes lodge directions without a door-code field when no code is set", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000, {
        lodgeTravelNote: "Take the Bruce Road and carry chains.",
        doorCode: null,
      });

      expect(html).toContain("How to get to the lodge");
      expect(html).toContain("Take the Bruce Road and carry chains.");
      expect(html).not.toContain("Door code");
    });

    it("explains the split provisional guest portion when this is a split parent (#1942)", () => {
      const holdUntil = new Date("2026-07-08T00:30:00Z");
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 2, 10000, {
        provisionalGuests: { guestCount: 2, holdUntil },
      });

      expect(html).toContain("2 non-member guests");
      expect(html).toContain("held provisionally");
      expect(html).toContain("no bed is reserved for them yet");
      expect(html).toContain("covers only your member places");
      expect(html).toContain(formatNZDateTime(holdUntil));
    });

    it("uses singular wording for a single provisional guest (#1942)", () => {
      const holdUntil = new Date("2026-07-08T00:30:00Z");
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 1, 10000, {
        provisionalGuests: { guestCount: 1, holdUntil },
      });

      expect(html).toContain("1 non-member guest is held provisionally");
    });

    it("omits the provisional section for an ordinary (non-split) confirmation (#1942)", () => {
      const html = bookingConfirmedTemplate("Test", checkIn, checkOut, 2, 10000);
      expect(html).not.toContain("held provisionally");
    });
  });

  describe("bookingPendingTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");
    const holdUntil = new Date("2026-07-08T00:30:00Z");

    it("includes pending explanation", () => {
      const html = bookingPendingTemplate("Alice", checkIn, checkOut, 3, holdUntil);
      expect(html).toContain("Booking Pending");
      expect(html).toContain("non-member");
    });

    it("mentions card won't be charged", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).toContain("only be charged when the booking is confirmed");
    });

    it("shows the exact NZ-local hold deadline", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).toContain(formatNZDateTime(holdUntil));
    });

    it("does not include lodge directions or door codes", () => {
      const html = bookingPendingTemplate("Test", checkIn, checkOut, 1, holdUntil);
      expect(html).not.toContain("How to get to the lodge");
      expect(html).not.toContain("Door code");
      expect(html).not.toContain("A1234");
    });
  });

  describe("preArrivalReminderTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes directions and current door code when set", () => {
      const html = preArrivalReminderTemplate({
        firstName: "Alice",
        checkIn,
        checkOut,
        guestCount: 2,
        expectedArrivalTime: "16:30",
        lodgeTravelNote: "Park below the lodge and walk up.",
        doorCode: "9876",
      });

      expect(html).toContain("Upcoming Lodge Stay");
      expect(html).toContain("Park below the lodge and walk up.");
      expect(html).toContain("Door code");
      expect(html).toContain("9876");
      expect(html).toContain("16:30");
    });

    it("omits the door-code field when no code is set", () => {
      const html = preArrivalReminderTemplate({
        firstName: "Alice",
        checkIn,
        checkOut,
        guestCount: 2,
        lodgeTravelNote: "Park below the lodge and walk up.",
        doorCode: null,
      });

      expect(html).toContain("Park below the lodge and walk up.");
      expect(html).not.toContain("Door code");
    });
  });

  describe("bookingBumpedTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("includes bumped explanation", () => {
      const html = bookingBumpedTemplate("Alice", checkIn, checkOut, 2);
      expect(html).toContain("bumped");
      expect(html).toContain("member demand");
    });

    it("clarifies no charge", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1);
      expect(html).toContain("not been charged");
    });

    it("includes rebook link", () => {
      const html = bookingBumpedTemplate("Test", checkIn, checkOut, 1);
      expect(html).toContain("/book");
    });
  });

  describe("bookingCancelledTemplate", () => {
    const checkIn = new Date("2026-07-15");
    const checkOut = new Date("2026-07-18");

    it("shows refund amount when applicable", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 25000);
      expect(html).toContain("$250.00");
      expect(html).toContain("refund");
    });

    it("shows no refund message when zero", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 0);
      expect(html).toContain("No refund was applicable");
    });

    it("surfaces restored applied credit subject to the cancellation policy (#1164)", () => {
      const html = bookingCancelledTemplate(
        "Alice",
        checkIn,
        checkOut,
        0,
        "card",
        1500
      );
      expect(html).toContain("$15.00");
      expect(html).toContain("previously applied account credit");
      expect(html).toContain("per the cancellation policy");
    });

    it("omits the restored-credit line when nothing was restored", () => {
      const html = bookingCancelledTemplate("Alice", checkIn, checkOut, 25000);
      expect(html).not.toContain("previously applied account credit");
    });
  });

  describe("choreRosterTemplate", () => {
    it("includes chore list", () => {
      const html = choreRosterTemplate("Bob", "2026-07-15", [
        { name: "Dishes", description: "Wash all dishes" },
        { name: "Sweep", description: null },
      ]);
      expect(html).toContain("Dishes");
      expect(html).toContain("Sweep");
      expect(html).toContain("Wash all dishes");
    });

    it("includes heater/fire safety reminder", () => {
      const html = choreRosterTemplate("Test", "2026-07-15", []);
      expect(html).toContain("heaters and fire");
    });
  });

  describe("hutLeaderAssignmentTemplate", () => {
    const startDate = new Date("2026-07-15");
    const endDate = new Date("2026-07-18");

    it("includes the hut leader PIN and lodge link", () => {
      const html = hutLeaderAssignmentTemplate({
        firstName: "Alice",
        startDate,
        endDate,
        pin: "123456",
        assignmentId: "assign-abc123",
      });

      expect(html).toContain("123456");
      expect(html).toContain("/lodge");
    });

    it("includes assignment responsibilities", () => {
      const html = hutLeaderAssignmentTemplate({
        firstName: "Alice",
        startDate,
        endDate,
        pin: "123456",
        assignmentId: "assign-abc123",
      });

      expect(html).toContain("arrivals");
      expect(html).toContain("roster");
    });
  });

  describe("time-sensitive templates", () => {
    it("uses NZ-local date-time formatting for admin pending deadlines", () => {
      const deadline = new Date("2026-04-14T09:15:00Z");
      const html = adminPendingDeadlineTemplate([
        {
          memberName: "Jane Doe",
          checkIn: new Date("2026-04-15"),
          checkOut: new Date("2026-04-17"),
          guestCount: 3,
          deadline,
          hoursRemaining: 20,
        },
      ]);

      expect(html).toContain(formatNZDateTime(deadline));
    });

    it("uses NZ-local date-time formatting for waitlist offer expiry", () => {
      const expiresAt = new Date("2026-07-10T05:45:00Z");
      const html = waitlistOfferTemplate(
        "Jane",
        new Date("2026-07-01"),
        new Date("2026-07-03"),
        2,
        expiresAt,
        "booking123",
        10000
      );

      expect(html).toContain(formatNZDateTime(expiresAt));
    });
  });

  describe("support contact config", () => {
    it("renders the config-derived support email as a stable search key, and the removed SUPPORT_EMAIL env has no effect (#1986)", async () => {
      vi.resetModules();
      vi.stubEnv("EMAIL_FROM", "sender@example.com");
      // C7 #1986 removed the SUPPORT_EMAIL env override — email identity is now
      // DB-first / config-derived only. Setting the env var must NOT change what
      // the template bakes in (the config-derived search key that send-time
      // replacement later swaps for the live EmailMessageSetting.supportEmail).
      vi.stubEnv("SUPPORT_EMAIL", "help@example.com");

      const [{ accountDeletionApprovedTemplate }, { clubConfig }] =
        await Promise.all([
          import("../email-templates"),
          import("@/config/club"),
        ]);
      const html = accountDeletionApprovedTemplate("Alice");

      // The config-derived support address renders; the env value is ignored.
      expect(html).toContain(clubConfig.supportEmail);
      expect(html).not.toContain("help@example.com");

      vi.unstubAllEnvs();
    });
  });

  describe("issue report and refund free-text rendering", () => {
    it("preserves line breaks in issue report descriptions without trusting external URLs", () => {
      const html = adminIssueReportTemplate({
        memberName: "Casey Member",
        memberEmail: "casey@example.com",
        pageUrl: "https://evil.example/phish",
        pageTitle: "Broken page",
        description: "Line 1\n<script>alert(1)</script>\nLine 3",
        issueReportUrl: `${getAppBaseUrl()}/admin/issue-reports?report=issue-1`,
        hasScreenshot: true,
      });

      expect(html).toContain("white-space: pre-wrap");
      expect(html).toContain("Line 1\n&lt;script&gt;alert(1)&lt;/script&gt;\nLine 3");
      expect(html).not.toContain('href="https://evil.example/phish"');
      expect(html).toContain(`href="${getAppBaseUrl()}"`);
      expect(html).toContain("/admin/issue-reports?report=issue-1");
    });

    it("preserves line breaks in refund appeal reasons", () => {
      const html = adminRefundRequestTemplate({
        memberName: "Casey Member",
        bookingId: "booking-1",
        checkIn: new Date("2026-07-01"),
        checkOut: new Date("2026-07-03"),
        reason: "First line\nSecond line",
        requestedAmountCents: 2500,
        paidAmountCents: 5000,
        refundedAmountCents: 0,
      });

      expect(html).toContain("white-space: pre-wrap");
      expect(html).toContain("First line\nSecond line");
    });
  });
});
