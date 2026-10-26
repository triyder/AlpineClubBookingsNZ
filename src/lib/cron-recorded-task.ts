/**
 * The shared "run a recorded cron task" step (#3663). Its own module, not a
 * member of `cron-job-run.ts`, because the runners' suites double that module
 * whole; this one must stay real so they exercise it.
 */
import {
  recordCronJobRunSafe,
  type CronJobRunStatus,
  type RecordCronJobRunInput,
} from "@/lib/cron-job-run";

type RecordedCronTaskOutcome<T> =
  | { ok: true; result: T }
  | { ok: false; error: unknown; message: string };

/**
 * Run ONE cron task and record its `CronJobRun` row (#3663) — the one home for
 * "time it, record SUCCESS/FAILURE, never let the recording decide the outcome",
 * shared by the general, payments and Xero cron runners. It never throws: the
 * caller decides what a failure means for its cycle (collect and continue,
 * rethrow the original error, or wrap it).
 *
 * `onFailure` runs BEFORE the FAILURE row is written (the general and payments
 * runners page Sentry there). `statusFor`/`summaryFor`/`errorFor` let a runner
 * derive the row from the result (the Xero runner records SKIPPED; a task may
 * attach a `warning` that admin cron health surfaces; a task that returns its
 * partial failure, the Xero link cleanup since #4161, names it in `error`).
 */
export async function runRecordedCronTask<T>({
  jobName,
  work,
  recordCronRun = recordCronJobRunSafe,
  statusFor = () => "SUCCESS",
  summaryFor = (result) => result,
  errorFor,
  onFailure,
}: {
  jobName: string;
  work: () => Promise<T> | T;
  recordCronRun?: (input: RecordCronJobRunInput) => Promise<void> | void;
  statusFor?: (result: T) => CronJobRunStatus;
  summaryFor?: (result: T) => unknown;
  errorFor?: (result: T) => string | null;
  onFailure?: (error: unknown, message: string) => void;
}): Promise<RecordedCronTaskOutcome<T>> {
  const startedAt = new Date();
  try {
    const result = await work();
    await recordCronRun({
      jobName,
      startedAt,
      status: statusFor(result),
      resultSummary: summaryFor(result),
      ...(errorFor ? { error: errorFor(result) } : {}),
    });
    return { ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onFailure?.(error, message);
    await recordCronRun({ jobName, startedAt, status: "FAILURE", error: message });
    return { ok: false, error, message };
  }
}
