import { purgeExpiredBookingRequests } from "@/lib/booking-request";
import { confirmPendingBookings } from "@/lib/cron-confirm-pending";
import {
  recordCronJobRunSafe,
  type RecordCronJobRunInput,
} from "@/lib/cron-job-run";
import { reapStaleGroupSettlements } from "@/lib/cron-group-settlement-reaper";
import { sendPreArrivalReminders } from "@/lib/cron-pre-arrival-reminders";
import { sendQuoteExpiryReminders } from "@/lib/cron-quote-expiry-reminders";
import { sendSchoolAttendeeConfirmationPrompts } from "@/lib/school-attendee-confirmation";
import { reportCronError } from "@/lib/observability-bridge";

const GENERAL_CRON_JOB_NAMES = [
  "confirm-pending",
  "group-settlement-reaper",
  "pre-arrival-reminders",
  "purge-booking-requests",
  "quote-expiry-reminders",
  "school-attendee-confirmations",
] as const;

export type GeneralCronJobName = (typeof GENERAL_CRON_JOB_NAMES)[number];

export interface GeneralCronCycleResult {
  confirmPending: Awaited<ReturnType<typeof confirmPendingBookings>> | null;
  groupSettlementReap: Awaited<ReturnType<typeof reapStaleGroupSettlements>> | null;
  preArrivalReminders: Awaited<ReturnType<typeof sendPreArrivalReminders>> | null;
  bookingRequestPurge: Awaited<ReturnType<typeof purgeExpiredBookingRequests>> | null;
  quoteExpiryReminders: Awaited<ReturnType<typeof sendQuoteExpiryReminders>> | null;
  schoolAttendeeConfirmations: Awaited<
    ReturnType<typeof sendSchoolAttendeeConfirmationPrompts>
  > | null;
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
  tasks?: Partial<{
    confirmPendingBookings: typeof confirmPendingBookings;
    reapStaleGroupSettlements: typeof reapStaleGroupSettlements;
    sendPreArrivalReminders: typeof sendPreArrivalReminders;
    purgeExpiredBookingRequests: typeof purgeExpiredBookingRequests;
    sendQuoteExpiryReminders: typeof sendQuoteExpiryReminders;
    sendSchoolAttendeeConfirmationPrompts: typeof sendSchoolAttendeeConfirmationPrompts;
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
}: {
  task: GeneralCronTask<T>;
  recordCronRun: (input: RecordCronJobRunInput) => Promise<void> | void;
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
    // Top-level cron-task FAILURE: log at error AND page Sentry via the scoped
    // bridge (deduped per job). Per-item best-effort failures inside tasks stay
    // log-only.
    reportCronError({
      tag: task.jobName,
      err: error,
      message: task.failureMessage,
      context: { job: task.jobName },
    });
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
  const taskDependencies = dependencies.tasks ?? {};
  const result: GeneralCronCycleResult = {
    confirmPending: null,
    groupSettlementReap: null,
    preArrivalReminders: null,
    bookingRequestPurge: null,
    quoteExpiryReminders: null,
    schoolAttendeeConfirmations: null,
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
      jobName: "group-settlement-reaper",
      resultKey: "groupSettlementReap",
      failureMessage: "Group settlement reaper cron error",
      work:
        taskDependencies.reapStaleGroupSettlements ??
        reapStaleGroupSettlements,
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
    {
      jobName: "school-attendee-confirmations",
      resultKey: "schoolAttendeeConfirmations",
      failureMessage: "School attendee confirmation cron error",
      work:
        taskDependencies.sendSchoolAttendeeConfirmationPrompts ??
        sendSchoolAttendeeConfirmationPrompts,
    },
  ];

  for (const task of tasks) {
    try {
      const taskResult = await runRecordedTask({
        task,
        recordCronRun,
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
