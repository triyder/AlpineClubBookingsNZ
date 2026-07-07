import { prisma } from "./prisma";
import logger from "@/lib/logger";

export type CronJobRunStatus = "SUCCESS" | "FAILURE" | "SKIPPED";

export interface RecordCronJobRunInput {
  jobName: string;
  startedAt: Date;
  completedAt?: Date;
  status: CronJobRunStatus;
  resultSummary?: unknown;
  error?: string | null;
}

function serializeResultSummary(resultSummary: unknown) {
  return resultSummary === undefined
    ? undefined
    : JSON.parse(JSON.stringify(resultSummary));
}

async function recordCronJobRun({
  jobName,
  startedAt,
  completedAt = new Date(),
  status,
  resultSummary,
  error,
}: RecordCronJobRunInput) {
  await prisma.cronJobRun.create({
    data: {
      jobName,
      startedAt,
      completedAt,
      durationMs: completedAt.getTime() - startedAt.getTime(),
      status,
      resultSummary: serializeResultSummary(resultSummary),
      error: error ?? undefined,
    },
  });
}

export async function recordCronJobRunSafe(input: RecordCronJobRunInput) {
  try {
    await recordCronJobRun(input);
  } catch (err) {
    logger.error(
      { err, job: input.jobName },
      "Failed to record cron job run"
    );
  }
}

/**
 * Auto-prune old CronJobRun records (older than 90 days).
 */
export async function pruneCronRuns() {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const { count } = await prisma.cronJobRun.deleteMany({
      where: { startedAt: { lt: cutoff } },
    });
    if (count > 0) {
      logger.info({ job: "cron-prune", deletedCount: count }, "Pruned old cron job runs");
    }
  } catch (err) {
    logger.error({ err, job: "cron-prune" }, "Failed to prune old cron job runs");
  }
}
