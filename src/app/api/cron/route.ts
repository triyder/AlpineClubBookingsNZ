import { NextRequest, NextResponse } from "next/server";
import { requireCronSecret } from "@/lib/cron-auth";
import {
  GeneralCronCycleError,
  runGeneralCronCycle,
} from "@/lib/general-cron-runner";

/**
 * Manual trigger for the pending booking confirmation cron job.
 * Secured with CRON_SECRET header.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireCronSecret(request);
  if (unauthorized) return unauthorized;

  try {
    const result = await runGeneralCronCycle();

    return NextResponse.json({
      success: true,
      confirmed: result.confirmPending?.confirmedBookingIds ?? [],
      bumped: result.confirmPending?.bumpedBookingIds ?? [],
      partialBumped: result.confirmPending?.partialBumpedBookingIds ?? [],
      failed: result.confirmPending?.failedBookingIds ?? [],
      preArrivalReminders: result.preArrivalReminders,
      bookingRequestPurge: result.bookingRequestPurge,
      quoteExpiryReminders: result.quoteExpiryReminders,
    });
  } catch (err) {
    if (err instanceof GeneralCronCycleError) {
      return NextResponse.json(
        {
          error: "One or more cron jobs failed",
          failedJobs: err.failures,
          result: err.result,
        },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
