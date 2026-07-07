import { prisma } from "./prisma";
import { sendCheckinReminderEmail, shouldSendEmail } from "./email";
import { getNZSTTomorrow } from "./nzst-date";
import logger from "@/lib/logger";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { checkinNotBlockedByPendingReviewFilter } from "@/lib/booking-review";
import { CLUB_LODGE_NAME } from "@/config/club-identity";

/**
 * N-01: Send check-in reminder emails for bookings checking in tomorrow.
 * Runs daily at 9:00 AM NZST.
 * Skips bookings where a reminder has already been sent (checks EmailLog).
 */
export async function sendCheckinReminders(): Promise<{ sent: number; skipped: number }> {
  const now = new Date();
  const tomorrowNZ = getNZSTTomorrow();
  const dayAfterNZ = new Date(tomorrowNZ);
  dayAfterNZ.setDate(dayAfterNZ.getDate() + 1);

  // Find paid/operational bookings checking in tomorrow
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: {
        gte: tomorrowNZ,
        lt: dayAfterNZ,
      },
      // #1422: a booking blocked by a pending admin review can't check in until
      // an admin clears the review, so it should get no "check-in coming up"
      // reminder while blocked.
      ...checkinNotBlockedByPendingReviewFilter(),
    },
    include: {
      member: true,
      guests: true,
      choreAssignments: {
        where: {
          date: {
            gte: tomorrowNZ,
            lt: dayAfterNZ,
          },
        },
        include: {
          choreTemplate: true,
        },
      },
    },
  });

  let sent = 0;
  let skipped = 0;

  for (const booking of bookings) {
    // #1285: honor the member's "Check-in Reminders" notification preference.
    // Check-in reminders are optional/operational — NOT must-send transactional
    // mail — so a member who has switched this category off should not receive
    // one. (Booking confirmation/updates/cancellation notices are must-send and
    // are never gated.) `booking.member` is loaded via the `member: true`
    // include above, so the memberId is already in hand.
    const wantsReminder = await shouldSendEmail(
      booking.member.id,
      "bookingReminder",
    );
    if (!wantsReminder) {
      skipped++;
      continue;
    }

    // Check if reminder already sent (look for checkin-reminder template for this booking's email+subject)
    const alreadySent = await prisma.emailLog.findFirst({
      where: {
        templateName: "checkin-reminder",
        to: booking.member.email,
        subject: `Check-in Reminder - ${CLUB_LODGE_NAME}`,
        status: "SENT",
        // Only check within the last 48h to avoid false matches from old bookings
        createdAt: { gte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
      },
    });

    if (alreadySent) {
      skipped++;
      continue;
    }

    const chores = booking.choreAssignments.map((a) => ({
      name: a.choreTemplate.name,
      description: a.choreTemplate.description,
    }));

    const guests = booking.guests.map((g) => ({
      firstName: g.firstName,
      lastName: g.lastName,
    }));

    try {
      await sendCheckinReminderEmail(
        booking.member.email,
        booking.member.firstName,
        booking.checkIn,
        booking.checkOut,
        guests,
        chores,
        booking.lodgeId
      );
      sent++;
    } catch (err) {
      logger.error({ err, bookingId: booking.id }, "Failed to send check-in reminder");
    }
  }

  return { sent, skipped };
}
