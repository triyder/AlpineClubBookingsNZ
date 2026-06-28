import { BookingRequestQuoteStatus } from "@prisma/client";
import { issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import {
  getBookingRequestSettings,
  parseBookingRequestGuests,
} from "@/lib/booking-request";
import { parseBookingRequestQuoteOptions } from "@/lib/booking-request-quotes";
import { sendBookingRequestQuoteEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Send a single pre-expiry reminder for public booking-request quotes that are
 * still awaiting a response. The reminder rotates the quote's response token and
 * emails a fresh working link, so the requester never has to find the original
 * quote email. Each quote is reminded at most once (tracked by `reminderSentAt`).
 *
 * Reminders are disabled when the admin sets `quoteReminderLeadDays` to 0.
 */
export async function sendQuoteExpiryReminders(): Promise<{
  remindedCount: number;
  failedCount: number;
}> {
  const settings = await getBookingRequestSettings();
  const leadDays = settings.quoteReminderLeadDays;
  if (leadDays <= 0) {
    return { remindedCount: 0, failedCount: 0 };
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + leadDays * DAY_MS);

  const quotes = await prisma.bookingRequestQuote.findMany({
    where: {
      status: BookingRequestQuoteStatus.SENT,
      reminderSentAt: null,
      responseTokenExpiresAt: { gt: now, lte: windowEnd },
    },
    include: { bookingRequest: true },
  });

  let remindedCount = 0;
  let failedCount = 0;

  for (const quote of quotes) {
    const request = quote.bookingRequest;
    const expiresAt = quote.responseTokenExpiresAt;
    if (!expiresAt) continue;

    // Rotate the response token first so the reminder email carries a working
    // link. `reminderSentAt` is only set after a successful send, so a delivery
    // failure is retried on the next run rather than silently swallowed.
    const { token, tokenHash } = issueActionToken();
    await prisma.bookingRequestQuote.update({
      where: { id: quote.id },
      data: { responseTokenHash: tokenHash },
    });

    try {
      const options = parseBookingRequestQuoteOptions(quote.options);
      await sendBookingRequestQuoteEmail({
        email: request.contactEmail,
        firstName: request.contactFirstName,
        token,
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guestCount: parseBookingRequestGuests(request.guests).length,
        requestType: request.type,
        schoolName: request.schoolName,
        options: options.map((option) => ({
          label: option.label,
          totalCents: option.totalCents,
        })),
        message: quote.message,
        expiresAt,
        isReminder: true,
      });

      await prisma.bookingRequestQuote.update({
        where: { id: quote.id },
        data: { reminderSentAt: now },
      });

      remindedCount += 1;
      logAudit({
        action: "booking_request.quote_reminder_sent",
        targetId: request.id,
        entityType: "BookingRequest",
        entityId: request.id,
        category: "booking",
        outcome: "success",
        summary: "Sent a pre-expiry reminder for an outstanding quote",
        metadata: {
          quoteId: quote.id,
          version: quote.version,
          expiresAt: expiresAt.toISOString(),
        },
      });
    } catch (err) {
      failedCount += 1;
      logger.error(
        { err, quoteId: quote.id, bookingRequestId: quote.bookingRequestId },
        "Failed to send booking request quote reminder",
      );
    }
  }

  return { remindedCount, failedCount };
}
