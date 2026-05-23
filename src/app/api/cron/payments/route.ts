import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processPaymentRecoveryOperations } from "@/lib/payment-recovery";
import logger from "@/lib/logger";

const VALID_PAYMENT_CRON_TASKS = new Set(["recovery"]);

function isAuthorizedCronRequest(request: NextRequest) {
  const cronSecret = request.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  return !!(
    cronSecret &&
    expected &&
    cronSecret.length === expected.length &&
    timingSafeEqual(Buffer.from(cronSecret), Buffer.from(expected))
  );
}

async function recordCronRun({
  startedAt,
  status,
  resultSummary,
  error,
}: {
  startedAt: Date;
  status: "SUCCESS" | "FAILURE";
  resultSummary?: Record<string, unknown>;
  error?: string;
}) {
  const completedAt = new Date();
  try {
    await prisma.cronJobRun.create({
      data: {
        jobName: "payment-recovery",
        startedAt,
        completedAt,
        durationMs: completedAt.getTime() - startedAt.getTime(),
        status,
        resultSummary: resultSummary
          ? JSON.parse(JSON.stringify(resultSummary))
          : undefined,
        error,
      },
    });
  } catch (err) {
    logger.error({ err, job: "payment-recovery" }, "Failed to record payment recovery cron run");
  }
}

/**
 * POST /api/cron/payments?task=recovery
 * Secured manual trigger for durable Stripe payment recovery work.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const task = request.nextUrl.searchParams.get("task") ?? "recovery";
  if (!VALID_PAYMENT_CRON_TASKS.has(task)) {
    return NextResponse.json(
      { error: "Invalid task. Expected recovery." },
      { status: 400 }
    );
  }

  const startedAt = new Date();
  try {
    const recovery = await processPaymentRecoveryOperations();
    await recordCronRun({
      startedAt,
      status: "SUCCESS",
      resultSummary: { ...recovery },
    });

    return NextResponse.json({
      message: "Payment recovery completed",
      task,
      recovery,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, task }, "Payment cron job error");
    await recordCronRun({
      startedAt,
      status: "FAILURE",
      error: message,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
