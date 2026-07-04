import { APP_TIME_ZONE } from "@/config/operational";
import type { FeatureFlags } from "@/config/schema";

const CRON_TIMEZONE = APP_TIME_ZONE;

// test seam
export function getOptionalCronRegistrationState(flags?: FeatureFlags) {
  void flags;

  return {
    financeDailySync: true,
    waitlistProcessor: true,
    xeroIntegration: true,
  };
}

function sentryCronMonitorConfig(
  schedule: string,
  options: { checkinMargin?: number; maxRuntime?: number } = {}
) {
  return {
    schedule: { type: "crontab" as const, value: schedule },
    timezone: CRON_TIMEZONE,
    ...options,
  };
}

/**
 * Next.js instrumentation hook.
 * Runs once when the server starts.
 * Initializes Sentry and schedules cron jobs.
 */
export async function register() {
  // OBS-01: Initialize Sentry for the Node.js runtime
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { default: logger } = await import("./lib/logger");
    const cronEnabled = (process.env.CRON_ENABLED ?? "true").toLowerCase() === "true";

    if (!cronEnabled) {
      logger.info(
        { cronEnabled: process.env.CRON_ENABLED ?? "true" },
        "Cron scheduling disabled for this app instance"
      );
      return;
    }

    const cron = await import("node-cron");
    const Sentry = await import("@sentry/nextjs");
    const { prisma } = await import("./lib/prisma");
    const { deleteDraftBookingDependents } = await import("./lib/draft-booking-cleanup");
    const { isXeroDailyMembershipRefreshEnabled } = await import("./lib/xero-feature-flags");
    const { isEffectiveModuleEnabled } = await import("./lib/admin-modules");
    const { reportCronError } = await import("./lib/observability-bridge");
    const optionalCron = getOptionalCronRegistrationState();

    // Verify Prisma client is ready before starting cron jobs
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      logger.info("Prisma client verified — database connection OK");
    } catch (err) {
      logger.error({ err }, "Prisma client startup check failed — cron jobs may be unreliable");
      Sentry.captureException(err);
    }

    // Overlap guards: prevent concurrent execution of the same cron job
    let isGeneralCronRunning = false;
    let isXeroCronRunning = false;
    let isXeroBackfillCronRunning = false;
    let isXeroLinkCleanupCronRunning = false;
    let isXeroReportCronRunning = false;
    let isXeroReplayCronRunning = false;
    let isXeroInboundCronRunning = false;
    let isPaymentRecoveryCronRunning = false;
    let isWaitlistCronRunning = false;

    // Helper: record a cron job run
    async function recordCronRun(
      jobName: string,
      startedAt: Date,
      status: string,
      resultSummary?: Record<string, unknown>,
      error?: string
    ) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      try {
        await prisma.cronJobRun.create({
          data: {
            jobName,
            startedAt,
            completedAt,
            durationMs,
            status,
            resultSummary: resultSummary ? JSON.parse(JSON.stringify(resultSummary)) : undefined,
            error: error ?? undefined,
          },
        });
      } catch (err) {
        logger.error({ err, job: jobName }, "Failed to record cron job run");
      }
    }

    // OBS-03: General booking and public-request cron cycle (every 3 hours)
    cron.default.schedule("0 */3 * * *", async () => {
      if (isGeneralCronRunning) {
        logger.info({ job: "general-cron" }, "Already running, skipping");
        return;
      }
      isGeneralCronRunning = true;
      logger.info(
        { job: "general-cron" },
        "Running booking and public-request cron cycle"
      );

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "confirm-pending-bookings", status: "in_progress" },
        sentryCronMonitorConfig("0 */3 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );

      try {
        const { runGeneralCronCycle } = await import(
          "./lib/general-cron-runner"
        );
        const result = await runGeneralCronCycle();
        logger.info(
          {
            job: "general-cron",
            confirmed: result.confirmPending?.confirmedBookingIds.length ?? 0,
            bumped: result.confirmPending?.bumpedBookingIds.length ?? 0,
            failed: result.confirmPending?.failedBookingIds.length ?? 0,
            preArrivalSent:
              result.preArrivalReminders?.sentBookingIds.length ?? 0,
            quotesReminded:
              result.quoteExpiryReminders?.remindedCount ?? 0,
          },
          "Booking and public-request cron cycle complete"
        );
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "ok" });
      } catch (err) {
        // Each failed task already bridged to Sentry per-job inside the general
        // cron runner (reportCronError), so the cycle-level catch only logs the
        // aggregate + marks the monitor check-in to avoid a double-send.
        logger.error({ err, job: "general-cron" }, "Error in booking and public-request cron cycle");
        Sentry.captureCheckIn({ checkInId, monitorSlug: "confirm-pending-bookings", status: "error" });
      } finally {
        isGeneralCronRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info(
      { job: "general-cron" },
      "Scheduled booking and public-request cron cycle (every 3 hours)"
    );

    cron.default.schedule("*/15 * * * *", async () => {
      if (isPaymentRecoveryCronRunning) {
        logger.info({ job: "payment-recovery" }, "Already running, skipping");
        return;
      }
      isPaymentRecoveryCronRunning = true;
      const startedAt = new Date();

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "payment-recovery", status: "in_progress" },
        sentryCronMonitorConfig("*/15 * * * *", { checkinMargin: 5, maxRuntime: 10 })
      );

      try {
        const { processPaymentRecoveryOperations } = await import(
          "./lib/payment-recovery"
        );
        const result = await processPaymentRecoveryOperations();
        logger.info({ job: "payment-recovery", ...result }, "Payment recovery cron complete");
        await recordCronRun("payment-recovery", startedAt, "SUCCESS", { ...result });
        Sentry.captureCheckIn({ checkInId, monitorSlug: "payment-recovery", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "payment-recovery", err, message: "Error in payment recovery cron" });
        await recordCronRun("payment-recovery", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "payment-recovery", status: "error" });
      } finally {
        isPaymentRecoveryCronRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "payment-recovery" }, "Scheduled payment recovery (every 15 minutes)");

    if (optionalCron.xeroIntegration) {
      // OBS-03: Cron job 2 - Xero membership refresh safety net (daily at 2 AM)
      if (isXeroDailyMembershipRefreshEnabled()) {
        cron.default.schedule("0 2 * * *", async () => {
          if (isXeroCronRunning) {
            logger.info({ job: "xero-membership-refresh" }, "Already running, skipping");
            return;
          }
          isXeroCronRunning = true;
          logger.info(
            { job: "xero-membership-refresh" },
            "Running daily Xero membership safety-net refresh"
          );

          const checkInId = Sentry.captureCheckIn(
            { monitorSlug: "xero-membership-refresh", status: "in_progress" },
            sentryCronMonitorConfig("0 2 * * *", { checkinMargin: 10, maxRuntime: 60 })
          );

          try {
            const { runXeroCronTasks } = await import(
              "./lib/xero-cron-runner"
            );
            const result = await runXeroCronTasks("memberships");
            logger.info(
              { job: "xero-membership-refresh", result: result.membershipRefresh },
              "Xero membership safety-net refresh complete"
            );
            Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-membership-refresh", status: "ok" });
          } catch (err) {
            reportCronError({
              tag: "xero-membership-refresh",
              err,
              message: "Error running Xero membership safety-net refresh",
            });
            Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-membership-refresh", status: "error" });
          } finally {
            isXeroCronRunning = false;
          }
        }, { timezone: CRON_TIMEZONE });

        logger.info(
          { job: "xero-membership-refresh" },
          "Scheduled Xero membership safety-net refresh (daily at 2 AM NZST)"
        );
      } else {
        logger.info(
          { job: "xero-membership-refresh" },
          "Xero membership refresh disabled by XERO_ENABLE_DAILY_MEMBERSHIP_REFRESH"
        );
      }

      // Historical Xero link backfill (daily at 2:20 AM NZST)
      cron.default.schedule("20 2 * * *", async () => {
        if (isXeroBackfillCronRunning) {
          logger.info({ job: "xero-link-backfill" }, "Already running, skipping");
          return;
        }
        isXeroBackfillCronRunning = true;
        logger.info({ job: "xero-link-backfill" }, "Backfilling canonical Xero links into the ledger");

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-link-backfill", status: "in_progress" },
          sentryCronMonitorConfig("20 2 * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("backfill", {
            includeLinkCleanupForBackfill: false,
          });
          logger.info(
            { job: "xero-link-backfill", result: result.linkBackfill },
            "Xero link backfill complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-backfill", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-link-backfill", err, message: "Error backfilling historical Xero links" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-backfill", status: "error" });
        } finally {
          isXeroBackfillCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info({ job: "xero-link-backfill" }, "Scheduled Xero link backfill (daily at 2:20 AM NZST)");

      // Stale canonical Xero link cleanup (daily at 2:25 AM NZST)
      cron.default.schedule("25 2 * * *", async () => {
        if (isXeroLinkCleanupCronRunning) {
          logger.info({ job: "xero-link-cleanup" }, "Already running, skipping");
          return;
        }
        isXeroLinkCleanupCronRunning = true;
        logger.info({ job: "xero-link-cleanup" }, "Cleaning stale canonical Xero links");

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-link-cleanup", status: "in_progress" },
          sentryCronMonitorConfig("25 2 * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("link-cleanup");
          logger.info(
            { job: "xero-link-cleanup", result: result.linkCleanup },
            "Xero stale link cleanup complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-cleanup", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-link-cleanup", err, message: "Error cleaning stale Xero links" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-link-cleanup", status: "error" });
        } finally {
          isXeroLinkCleanupCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info({ job: "xero-link-cleanup" }, "Scheduled Xero stale link cleanup (daily at 2:25 AM NZST)");

      // Nightly Xero reconciliation report (daily at 2:35 AM NZST)
      cron.default.schedule("35 2 * * *", async () => {
        if (isXeroReportCronRunning) {
          logger.info({ job: "xero-reconciliation-report" }, "Already running, skipping");
          return;
        }
        isXeroReportCronRunning = true;
        logger.info({ job: "xero-reconciliation-report" }, "Building nightly Xero reconciliation report");

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-reconciliation-report", status: "in_progress" },
          sentryCronMonitorConfig("35 2 * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("report");
          logger.info(
            { job: "xero-reconciliation-report", result: result.reconciliationReport },
            "Xero reconciliation report complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-reconciliation-report", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-reconciliation-report", err, message: "Error building Xero reconciliation report" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-reconciliation-report", status: "error" });
        } finally {
          isXeroReportCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info(
        { job: "xero-reconciliation-report" },
        "Scheduled Xero reconciliation report (daily at 2:35 AM NZST)"
      );

      // Xero outbox and replay workers (every 15 minutes)
      cron.default.schedule("*/15 * * * *", async () => {
        if (isXeroReplayCronRunning) {
          logger.info({ job: "xero-operation-replay" }, "Already running, skipping");
          return;
        }
        isXeroReplayCronRunning = true;
        logger.info(
          { job: "xero-operation-replay" },
          "Processing queued Xero outbox operations and retries"
        );

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-operation-replay", status: "in_progress" },
          sentryCronMonitorConfig("*/15 * * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTaskList } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTaskList(["outbox", "retries"], {
            taskLabel: "xero-queue",
          });
          logger.info(
            {
              job: "xero-operation-replay",
              queuedOutboxOperations: result.queuedOutboxOperations,
              queuedRetries: result.queuedRetries,
            },
            "Queued Xero outbox and retry processing complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-operation-replay", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-operation-replay", err, message: "Error processing queued Xero work" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-operation-replay", status: "error" });
        } finally {
          isXeroReplayCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info(
        { job: "xero-operation-replay" },
        "Scheduled queued Xero outbox and retry processing (every 15 minutes)"
      );

      // Xero inbound webhook reconciliation safety net (every 15 minutes)
      cron.default.schedule("*/15 * * * *", async () => {
        if (isXeroInboundCronRunning) {
          logger.info({ job: "xero-inbound-reconcile" }, "Already running, skipping");
          return;
        }
        isXeroInboundCronRunning = true;
        logger.info(
          { job: "xero-inbound-reconcile" },
          "Running Xero inbound reconciliation cycle"
        );

        const checkInId = Sentry.captureCheckIn(
          { monitorSlug: "xero-inbound-reconcile", status: "in_progress" },
          sentryCronMonitorConfig("*/15 * * * *", { checkinMargin: 10, maxRuntime: 30 })
        );

        try {
          const { runXeroCronTasks } = await import(
            "./lib/xero-cron-runner"
          );
          const result = await runXeroCronTasks("inbound");
          logger.info(
            { job: "xero-inbound-reconcile", result: result.inboundReconciliation },
            "Xero inbound reconciliation cycle complete"
          );
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-inbound-reconcile", status: "ok" });
        } catch (err) {
          reportCronError({ tag: "xero-inbound-reconcile", err, message: "Error processing stored Xero inbound events" });
          Sentry.captureCheckIn({ checkInId, monitorSlug: "xero-inbound-reconcile", status: "error" });
        } finally {
          isXeroInboundCronRunning = false;
        }
      }, { timezone: CRON_TIMEZONE });

      logger.info(
        { job: "xero-inbound-reconcile" },
        "Scheduled stored Xero inbound reconciliation (every 15 minutes)"
      );
    }

    if (optionalCron.financeDailySync) {
      const {
        FINANCE_SYNC_CRON_JOB_NAME,
        FINANCE_SYNC_CRON_SCHEDULE,
        FINANCE_SYNC_CRON_TIMEZONE,
      } = await import(
        "./lib/finance-sync-cron-config"
      );

      cron.default.schedule(
        FINANCE_SYNC_CRON_SCHEDULE,
        async () => {
          const { runDailyFinanceSyncCron } = await import(
            "./lib/finance-sync-cron"
          );
          await runDailyFinanceSyncCron({
            logger,
            isModuleEnabled: () => isEffectiveModuleEnabled("financeDashboard"),
          });
        },
        { timezone: FINANCE_SYNC_CRON_TIMEZONE }
      );

      logger.info(
        {
          job: FINANCE_SYNC_CRON_JOB_NAME,
          schedule: FINANCE_SYNC_CRON_SCHEDULE,
          timezone: FINANCE_SYNC_CRON_TIMEZONE,
        },
        "Scheduled daily finance sync"
      );
    } else {
      logger.info(
        { moduleKey: "financeDashboard", job: "finance-sync" },
        "Finance sync cron registration skipped because the module is off"
      );
    }

    // OBS-03: Cron job 3 - Database backup (daily at 3 AM)
    let isBackupRunning = false;
    const backupSchedule = process.env.BACKUP_CRON_SCHEDULE || "0 3 * * *";

    cron.default.schedule(backupSchedule, async () => {
      if (isBackupRunning) {
        logger.info({ job: "backup" }, "Already running, skipping");
        return;
      }
      isBackupRunning = true;
      const startedAt = new Date();
      logger.info({ job: "backup" }, "Starting database backup");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "database-backup", status: "in_progress" },
        sentryCronMonitorConfig(backupSchedule, { checkinMargin: 10, maxRuntime: 30 })
      );

      try {
        const { buildBackupCronOutcome, runDatabaseBackup } = await import("./lib/backup");
        const result = await runDatabaseBackup();
        const outcome = buildBackupCronOutcome(result);

        if (outcome.status === "SUCCESS") {
          logger.info(
            { job: "backup", ...outcome.resultSummary },
            "Database backup complete"
          );
          await recordCronRun("backup", startedAt, "SUCCESS", outcome.resultSummary);
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "ok" });
        } else if (outcome.status === "SKIPPED") {
          logger.info(
            { job: "backup", ...outcome.resultSummary },
            "Database backup skipped"
          );
          await recordCronRun("backup", startedAt, "SKIPPED", outcome.resultSummary);
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "ok" });
        } else {
          logger.error({ job: "backup", error: outcome.error }, "Database backup failed");
          await recordCronRun("backup", startedAt, "FAILURE", undefined, outcome.error);
          Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "error" });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "backup", err, message: "Error running database backup" });
        await recordCronRun("backup", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "database-backup", status: "error" });
      } finally {
        isBackupRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "backup", schedule: backupSchedule }, "Scheduled database backup");

    // Data pruning cron (daily at 3:30 AM NZST — staggered from backup at 3:00 AM)
    let isPruningRunning = false;
    cron.default.schedule("30 3 * * *", async () => {
      if (isPruningRunning) {
        logger.info({ job: "data-pruning" }, "Already running, skipping");
        return;
      }
      isPruningRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "data-pruning", status: "in_progress" },
        sentryCronMonitorConfig("30 3 * * *", { checkinMargin: 10, maxRuntime: 60 })
      );
      try {
        const { pruneCronRuns } = await import("./lib/cron-job-run");
        const { pruneWebhookLogs } = await import("./lib/webhook-log");
        const { runAuditLogRetentionJob } = await import("./lib/audit-retention");
        await pruneCronRuns();
        await pruneWebhookLogs();
        const auditRetention = await runAuditLogRetentionJob();
        // Prune expired tokens
        await prisma.emailVerificationToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.emailChangeToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.guestChoreToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        await prisma.passwordResetToken.deleteMany({
          where: { expiresAt: { lt: new Date() } },
        });
        logger.info({ job: "data-pruning" }, "Data pruning complete");
        await recordCronRun("data-pruning", startedAt, "SUCCESS", {
          auditRetention: {
            anonymized: auditRetention.requestData.anonymized,
            archived: auditRetention.archive.archived,
            archiveSkipped: auditRetention.archive.skipped,
            mainPruned: auditRetention.mainPrune.deleted,
            archivePruned: auditRetention.archivePrune.pruned,
          },
        });
        Sentry.captureCheckIn({ checkInId, monitorSlug: "data-pruning", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "data-pruning", err, message: "Error in data pruning" });
        await recordCronRun("data-pruning", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "data-pruning", status: "error" });
      } finally {
        isPruningRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "data-pruning" }, "Scheduled data pruning (daily at 3:30 AM NZST)");

    // Draft expiry cleanup (daily at 4:00 AM NZST)
    let isDraftCleanupRunning = false;
    cron.default.schedule("0 4 * * *", async () => {
      if (isDraftCleanupRunning) {
        logger.info({ job: "draft-cleanup" }, "Already running, skipping");
        return;
      }
      isDraftCleanupRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "draft-cleanup", status: "in_progress" },
        sentryCronMonitorConfig("0 4 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      try {
        const expiredBefore = new Date();
        const cleanup = await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(1)`);

          const expiredDrafts = await tx.booking.findMany({
            where: { status: "DRAFT", draftExpiresAt: { lt: expiredBefore } },
            select: {
              id: true,
              promoRedemption: { select: { id: true, promoCodeId: true } },
            },
          });

          const dependents = await deleteDraftBookingDependents(tx, expiredDrafts);
          const deleted = dependents.bookingIds.length
            ? await tx.booking.deleteMany({
                where: {
                  id: { in: dependents.bookingIds },
                  status: "DRAFT",
                  draftExpiresAt: { lt: expiredBefore },
                },
              })
            : { count: 0 };

          return {
            deletedDrafts: deleted.count,
            promoRedemptions: dependents.promoRedemptions,
            changeRequests: dependents.changeRequests,
            modifications: dependents.modifications,
          };
        });

        logger.info({ job: "draft-cleanup", ...cleanup }, "Draft cleanup complete");
        await recordCronRun("draft-cleanup", startedAt, "SUCCESS", cleanup);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "draft-cleanup", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "draft-cleanup", err, message: "Failed to delete expired draft bookings" });
        await recordCronRun("draft-cleanup", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "draft-cleanup", status: "error" });
      } finally {
        isDraftCleanupRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "draft-cleanup" }, "Scheduled draft cleanup (daily at 4:00 AM NZST)");

    // N-06: Cron job - Pending deadline alerts (daily at 8:00 AM NZST)
    let isPendingDeadlineRunning = false;
    cron.default.schedule("0 8 * * *", async () => {
      if (isPendingDeadlineRunning) {
        logger.info({ job: "pending-deadline-alerts" }, "Already running, skipping");
        return;
      }
      isPendingDeadlineRunning = true;
      const startedAt = new Date();
      logger.info({ job: "pending-deadline-alerts" }, "Checking for pending bookings approaching deadline");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "pending-deadline-alerts", status: "in_progress" },
        sentryCronMonitorConfig("0 8 * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { checkPendingDeadlines } = await import("./lib/cron-pending-deadline-alerts");
        const result = await checkPendingDeadlines();
        logger.info({ job: "pending-deadline-alerts", ...result }, "Pending deadline alerts complete");
        await recordCronRun("pending-deadline-alerts", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "pending-deadline-alerts", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "pending-deadline-alerts", err, message: "Error in pending deadline alerts" });
        await recordCronRun("pending-deadline-alerts", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "pending-deadline-alerts", status: "error" });
      } finally {
        isPendingDeadlineRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "pending-deadline-alerts" }, "Scheduled pending deadline alerts (daily at 8:00 AM NZST)");

    // Membership nomination reminders (daily at 8:15 AM NZST)
    let isNominationReminderRunning = false;
    cron.default.schedule("15 8 * * *", async () => {
      if (isNominationReminderRunning) {
        logger.info({ job: "nomination-reminders" }, "Already running, skipping");
        return;
      }
      isNominationReminderRunning = true;
      const startedAt = new Date();
      logger.info({ job: "nomination-reminders" }, "Checking expired nomination links for weekly reminders");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "nomination-reminders", status: "in_progress" },
        sentryCronMonitorConfig("15 8 * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { sendDueNominationReminders } = await import("./lib/nomination");
        const result = await sendDueNominationReminders();
        logger.info({ job: "nomination-reminders", ...result }, "Nomination reminders complete");
        await recordCronRun("nomination-reminders", startedAt, "SUCCESS", { ...result });
        Sentry.captureCheckIn({ checkInId, monitorSlug: "nomination-reminders", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "nomination-reminders", err, message: "Error in nomination reminders" });
        await recordCronRun("nomination-reminders", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "nomination-reminders", status: "error" });
      } finally {
        isNominationReminderRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "nomination-reminders" }, "Scheduled nomination reminders (daily at 8:15 AM NZST)");

    // N-01: Cron job - Check-in reminders (daily at 9:00 AM NZST)
    let isCheckinReminderRunning = false;
    cron.default.schedule("0 9 * * *", async () => {
      if (isCheckinReminderRunning) {
        logger.info({ job: "checkin-reminders" }, "Already running, skipping");
        return;
      }
      isCheckinReminderRunning = true;
      const startedAt = new Date();
      logger.info({ job: "checkin-reminders" }, "Sending check-in reminders");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "checkin-reminders", status: "in_progress" },
        sentryCronMonitorConfig("0 9 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );

      try {
        const { sendCheckinReminders } = await import("./lib/cron-checkin-reminders");
        const result = await sendCheckinReminders();
        logger.info({ job: "checkin-reminders", ...result }, "Check-in reminders complete");
        await recordCronRun("checkin-reminders", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "checkin-reminders", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "checkin-reminders", err, message: "Error in check-in reminders" });
        await recordCronRun("checkin-reminders", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "checkin-reminders", status: "error" });
      } finally {
        isCheckinReminderRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "checkin-reminders" }, "Scheduled check-in reminders (daily at 9:00 AM NZST)");

    // N-03: Cron job - Capacity warnings (daily at 7:00 AM NZST)
    let isCapacityWarningRunning = false;
    cron.default.schedule("0 7 * * *", async () => {
      if (isCapacityWarningRunning) {
        logger.info({ job: "capacity-warnings" }, "Already running, skipping");
        return;
      }
      isCapacityWarningRunning = true;
      const startedAt = new Date();
      logger.info({ job: "capacity-warnings" }, "Checking capacity for upcoming days");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "capacity-warnings", status: "in_progress" },
        sentryCronMonitorConfig("0 7 * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { checkCapacityWarnings } = await import("./lib/cron-capacity-warnings");
        const result = await checkCapacityWarnings();
        logger.info({ job: "capacity-warnings", ...result }, "Capacity warnings check complete");
        await recordCronRun("capacity-warnings", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "capacity-warnings", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "capacity-warnings", err, message: "Error in capacity warnings" });
        await recordCronRun("capacity-warnings", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "capacity-warnings", status: "error" });
      } finally {
        isCapacityWarningRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "capacity-warnings" }, "Scheduled capacity warnings (daily at 7:00 AM NZST)");

    // N-13: Cron job - Admin daily digest (daily at 7:30 AM NZST)
    let isAdminDigestRunning = false;
    cron.default.schedule("30 7 * * *", async () => {
      if (isAdminDigestRunning) {
        logger.info({ job: "admin-digest" }, "Already running, skipping");
        return;
      }
      isAdminDigestRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "admin-digest", status: "in_progress" },
        sentryCronMonitorConfig("30 7 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );
      logger.info({ job: "admin-digest" }, "Sending admin daily digest");

      try {
        const { sendAdminDigest } = await import("./lib/cron-admin-digest");
        const result = await sendAdminDigest();
        logger.info({ job: "admin-digest", ...result }, "Admin daily digest complete");
        await recordCronRun("admin-digest", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "admin-digest", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "admin-digest", err, message: "Error in admin daily digest" });
        await recordCronRun("admin-digest", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "admin-digest", status: "error" });
      } finally {
        isAdminDigestRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "admin-digest" }, "Scheduled admin daily digest (daily at 7:30 AM NZST)");

    // N-11: Cron job - Email retry (every 30 minutes)
    let isEmailRetryRunning = false;
    // Note: no timezone needed — runs every 30 min regardless of TZ
    cron.default.schedule("*/30 * * * *", async () => {
      if (isEmailRetryRunning) {
        logger.info({ job: "email-retry" }, "Already running, skipping");
        return;
      }
      isEmailRetryRunning = true;
      const startedAt = new Date();
      logger.info({ job: "email-retry" }, "Retrying failed emails");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "email-retry", status: "in_progress" },
        sentryCronMonitorConfig("*/30 * * * *", { checkinMargin: 10, maxRuntime: 10 })
      );

      try {
        const { retryFailedEmails } = await import("./lib/cron-email-retry");
        const result = await retryFailedEmails();
        logger.info({ job: "email-retry", ...result }, "Email retry complete");
        await recordCronRun("email-retry", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-retry", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "email-retry", err, message: "Error in email retry" });
        await recordCronRun("email-retry", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "email-retry", status: "error" });
      } finally {
        isEmailRetryRunning = false;
      }
    });

    logger.info({ job: "email-retry" }, "Scheduled email retry (every 30 minutes)");

    // Cron job - Complete bookings (daily at 1:00 AM NZST)
    // Transitions PAID bookings to COMPLETED once check-in date has passed
    let isCompleteBookingsRunning = false;
    cron.default.schedule("0 1 * * *", async () => {
      if (isCompleteBookingsRunning) {
        logger.info({ job: "complete-bookings" }, "Already running, skipping");
        return;
      }
      isCompleteBookingsRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "complete-bookings", status: "in_progress" },
        sentryCronMonitorConfig("0 1 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      logger.info({ job: "complete-bookings" }, "Transitioning PAID bookings to COMPLETED");

      try {
        const { completeBookings } = await import("./lib/cron-complete-bookings");
        const result = await completeBookings();
        logger.info({ job: "complete-bookings", ...result }, "Complete bookings cron finished");
        await recordCronRun("complete-bookings", startedAt, "SUCCESS", result as unknown as Record<string, unknown>);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "complete-bookings", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "complete-bookings", err, message: "Error in complete bookings cron" });
        await recordCronRun("complete-bookings", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "complete-bookings", status: "error" });
      } finally {
        isCompleteBookingsRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "complete-bookings" }, "Scheduled complete bookings (daily at 1:00 AM NZST)");

    // Hut leader auto-assign (daily at 6:00 AM NZST)
    let isHutLeaderAutoAssignRunning = false;
    cron.default.schedule("0 6 * * *", async () => {
      if (isHutLeaderAutoAssignRunning) {
        logger.info({ job: "hut-leader-auto-assign" }, "Already running, skipping");
        return;
      }
      isHutLeaderAutoAssignRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "hut-leader-auto-assign", status: "in_progress" },
        sentryCronMonitorConfig("0 6 * * *", { checkinMargin: 10, maxRuntime: 15 })
      );
      logger.info({ job: "hut-leader-auto-assign" }, "Running hut leader auto-assign");

      try {
        const { autoAssignHutLeaders } = await import("./lib/cron-hut-leader-auto-assign");
        const result = await autoAssignHutLeaders();
        logger.info({ job: "hut-leader-auto-assign", ...result }, "Hut leader auto-assign complete");
        await recordCronRun("hut-leader-auto-assign", startedAt, "SUCCESS", result as unknown as Record<string, unknown>);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "hut-leader-auto-assign", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "hut-leader-auto-assign", err, message: "Error in hut leader auto-assign" });
        await recordCronRun("hut-leader-auto-assign", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "hut-leader-auto-assign", status: "error" });
      } finally {
        isHutLeaderAutoAssignRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "hut-leader-auto-assign" }, "Scheduled hut leader auto-assign (daily at 6:00 AM NZST)");

    // Age-up cron (daily at 6:30 AM NZST) — detect members turning 18, grant login
    let isAgeUpRunning = false;
    cron.default.schedule("30 6 * * *", async () => {
      if (isAgeUpRunning) {
        logger.info({ job: "age-up" }, "Already running, skipping");
        return;
      }
      isAgeUpRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "age-up", status: "in_progress" },
        sentryCronMonitorConfig("30 6 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      logger.info({ job: "age-up" }, "Checking for members who have turned 18");

      try {
        const { checkAgeUpMembers } = await import("./lib/cron-age-up");
        const result = await checkAgeUpMembers();
        logger.info({ job: "age-up", ...result }, "Age-up check complete");
        await recordCronRun("age-up", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "age-up", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "age-up", err, message: "Error in age-up check" });
        await recordCronRun("age-up", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "age-up", status: "error" });
      } finally {
        isAgeUpRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "age-up" }, "Scheduled age-up check (daily at 6:30 AM NZST)");

    // ── Credit reconciliation (daily at 5:00 AM NZST) ──────────────────

    let isCreditReconRunning = false;

    cron.default.schedule("0 5 * * *", async () => {
      if (isCreditReconRunning) {
        logger.info({ job: "credit-reconciliation" }, "Already running, skipping");
        return;
      }
      isCreditReconRunning = true;
      const startedAt = new Date();
      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "credit-reconciliation", status: "in_progress" },
        sentryCronMonitorConfig("0 5 * * *", { checkinMargin: 10, maxRuntime: 30 })
      );
      logger.info({ job: "credit-reconciliation" }, "Starting credit balance reconciliation");

      try {
        const { reconcileCreditBalances } = await import("./lib/cron-credit-reconciliation");
        const result = await reconcileCreditBalances();
        logger.info({ job: "credit-reconciliation", ...result }, "Credit reconciliation complete");
        await recordCronRun("credit-reconciliation", startedAt, "SUCCESS", result);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "credit-reconciliation", status: "ok" });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "credit-reconciliation", err, message: "Error in credit reconciliation" });
        await recordCronRun("credit-reconciliation", startedAt, "FAILURE", undefined, message);
        Sentry.captureCheckIn({ checkInId, monitorSlug: "credit-reconciliation", status: "error" });
      } finally {
        isCreditReconRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "credit-reconciliation" }, "Scheduled credit reconciliation (daily at 5:00 AM NZST)");

    if (optionalCron.waitlistProcessor) {
    // Waitlist processor (every 30 minutes)
    cron.default.schedule("*/30 * * * *", async () => {
      if (isWaitlistCronRunning) {
        logger.info({ job: "waitlist-processor" }, "Already running, skipping");
        return;
      }
      isWaitlistCronRunning = true;
      const startedAt = new Date();
      logger.info({ job: "waitlist-processor" }, "Processing waitlist offers");

      const checkInId = Sentry.captureCheckIn(
        { monitorSlug: "waitlist-processor", status: "in_progress" },
        sentryCronMonitorConfig("*/30 * * * *")
      );

      try {
        const { runWaitlistProcessorCron } = await import("@/lib/cron-waitlist");
        const result = await runWaitlistProcessorCron({
          isModuleEnabled: () => isEffectiveModuleEnabled("waitlist"),
        });
        if (result.cronStatus === "SKIPPED") {
          logger.info({ job: "waitlist-processor", reason: result.reason }, "Waitlist processing skipped");
          Sentry.captureCheckIn({ checkInId, monitorSlug: "waitlist-processor", status: "ok" });
          await recordCronRun("waitlist-processor", startedAt, "SKIPPED", {
            reason: result.reason,
          });
        } else {
          logger.info({ job: "waitlist-processor", ...result }, "Waitlist processing complete");
          Sentry.captureCheckIn({ checkInId, monitorSlug: "waitlist-processor", status: "ok" });
          await recordCronRun("waitlist-processor", startedAt, "SUCCESS", result);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reportCronError({ tag: "waitlist-processor", err, message: "Error processing waitlist" });
        Sentry.captureCheckIn({ checkInId, monitorSlug: "waitlist-processor", status: "error" });
        await recordCronRun("waitlist-processor", startedAt, "FAILURE", undefined, message);
      } finally {
        isWaitlistCronRunning = false;
      }
    }, { timezone: CRON_TIMEZONE });

    logger.info({ job: "waitlist-processor" }, "Scheduled waitlist processor (every 30 minutes)");
    } else {
      logger.info(
        { moduleKey: "waitlist", job: "waitlist-processor" },
        "Waitlist cron registration skipped because the module is off"
      );
    }
  }
}

// OBS-02: Sentry onRequestError handler for server-side errors
export const onRequestError = async (
  err: unknown,
  request: { method: string; url: string; headers: Record<string, string> },
  context: { routerKind: string; routePath: string; routeType: string; renderSource: string }
) => {
  const Sentry = await import("@sentry/nextjs");
  Sentry.captureException(err, {
    tags: {
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
      renderSource: context.renderSource,
    },
    extra: {
      method: request.method,
      url: request.url,
    },
  });
};
