import { NextRequest, NextResponse } from "next/server";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";
import { requireCronSecret } from "@/lib/cron-auth";
import logger from "@/lib/logger";

/**
 * Manual trigger for the pending booking confirmation cron job.
 * Secured with CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await confirmPendingBookings();
    return NextResponse.json({
      success: true,
      confirmed: result.confirmedBookingIds,
      bumped: result.bumpedBookingIds,
      failed: result.failedBookingIds,
    });
  } catch (err) {
    logger.error({ err }, "Cron endpoint error");
    return NextResponse.json(
      { error: "Failed to process pending bookings" },
      { status: 500 }
    );
  }
}
