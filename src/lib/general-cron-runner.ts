import { purgeExpiredBookingRequests } from "@/lib/booking-request";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";
import {
  recordCronJobRunSafe,
  type RecordCronJobRunInput,
} from "@/lib/cron-job-run";
import { sendPreArrivalReminders } from "@/lib/cron-pre-arrival-reminders";
import { sendQuoteExpiryReminders } from "@/lib/cron-quote-expiry-reminders";
import logger from "@/lib/logger";

export const GENERAL_CRON_JOB_NAMES = [
  "confirm-pending",
  "pre-arrival-reminders",
  "purge-booking-requests",
  "quote-expiry-reminders",
] as const;

export type GeneralCronJobName = (typeof GENERAL_CRON_JOB_NAMES)[number];

export interface GeneralCronCycleResult {
  confirmPending: Awaited<ReturnType<typeof confirmPendingBookings>> | null;
  preArrivalReminders: Awaited<ReturnType<typeof sendPreArrivalReminders>> | null;
  bookingRequestPurge: Awaited<ReturnType<typeof purgeExpiredBookingRequests>> | null;
  quoteExpiryReminders: Awaited<ReturnType<typeof sendQuoteExpiryReminders>> | null;
}

type GeneralCronResultKey = keyof GeneralCronCycleResult;

type GeneralCronTask<T> = {
  jobName: GeneralCronJobName;
  resultKey: GeneralCronResultKey;
  failureMessage: string;
  work: () => Promise<T>;
};

export interface GeneralCronRunnerDependencies {
  recordCronRun?: (input: RecordCronJobRunInput) => Promise<void> | void;
  log?: Pick<typeof logger, "error" | "info">;
  tasks?: Partial<{
    confirmPendingBookings: typeof confirmPendingBookings;
    sendPreArrivalReminders: typeof sendPreArrivalReminders;
    purgeExpiredBookingRequests: typeof purgeExpiredBookingRequests;
    sendQuoteExpiryReminders: typeof sendQuoteExpiryReminders;
  }>;
}

export class GeneralCronCycleError extends Error {
  result: GeneralCronCycleResult;
  failures: Array<{ jobName: GeneralCronJobName; message: string }>;

  constructor(
    result: GeneralCronCycleResult,
    failures: Array<{ jobName: GeneralCronJobName; message: string }>
  ) {
    super(
      failures.length === 1
        ? failures[0].message
        : `General cron cycle failed for ${failures
            .map((failure) => failure.jobName)
            .join(", ")}`
    );
    this.name = "GeneralCronCycleError";
    this.result = result;
    this.failures = failures;
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function runRecordedTask<T>({
  task,
  recordCronRun,
  log,
}: {
  task: GeneralCronTask<T>;
  recordCronRun: (input: RecordCronJobRunInput) => Promise<void> | void;
  log: Pick<typeof logger, "error" | "info">;
}): Promise<T> {
  const startedAt = new Date();
  try {
    const result = await task.work();
    await recordCronRun({
      jobName: task.jobName,
      startedAt,
      status: "SUCCESS",
      resultSummary: result,
    });
    return result;
  } catch (error) {
    const message = toErrorMessage(error);
    log.error({ err: error, job: task.jobName }, task.failureMessage);
    await recordCronRun({
      jobName: task.jobName,
      startedAt,
      status: "FAILURE",
      error: message,
    });
    throw new Error(message);
  }
}

export async function runGeneralCronCycle(
  dependencies: GeneralCronRunnerDependencies = {}
): Promise<GeneralCronCycleResult> {
  const recordCronRun = dependencies.recordCronRun ?? recordCronJobRunSafe;
  const log = dependencies.log ?? logger;
  const taskDependencies = dependencies.tasks ?? {};
  const result: GeneralCronCycleResult = {
    confirmPending: null,
    preArrivalReminders: null,
    bookingRequestPurge: null,
    quoteExpiryReminders: null,
  };
  const failures: Array<{ jobName: GeneralCronJobName; message: string }> = [];
  const tasks: GeneralCronTask<unknown>[] = [
    {
      jobName: "confirm-pending",
      resultKey: "confirmPending",
      failureMessage: "Pending confirmation cron error",
      work:
        taskDependencies.confirmPendingBookings ??
        confirmPendingBookings,
    },
    {
      jobName: "pre-arrival-reminders",
      resultKey: "preArrivalReminders",
      failureMessage: "Pre-arrival reminder cron error",
      work:
        taskDependencies.sendPreArrivalReminders ??
        sendPreArrivalReminders,
    },
    {
      jobName: "purge-booking-requests",
      resultKey: "bookingRequestPurge",
      failureMessage: "Booking request retention purge cron error",
      work:
        taskDependencies.purgeExpiredBookingRequests ??
        purgeExpiredBookingRequests,
    },
    {
      jobName: "quote-expiry-reminders",
      resultKey: "quoteExpiryReminders",
      failureMessage: "Quote expiry reminder cron error",
      work:
        taskDependencies.sendQuoteExpiryReminders ??
        sendQuoteExpiryReminders,
    },
  ];

  for (const task of tasks) {
    try {
      const taskResult = await runRecordedTask({
        task,
        recordCronRun,
        log,
      });
      (result as Record<GeneralCronResultKey, unknown>)[task.resultKey] =
        taskResult;
    } catch (error) {
      failures.push({
        jobName: task.jobName,
        message: toErrorMessage(error),
      });
    }
  }

  if (failures.length > 0) {
    throw new GeneralCronCycleError(result, failures);
  }

  return result;
}
