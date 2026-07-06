import { FinanceSyncRunStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { createAuditLog, getAuditRequestContext } from "@/lib/audit";
import { requireFinanceManagerApiAccess } from "@/lib/finance-api-auth";
import {
  backfillFinanceMonthlyFacts,
  DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS,
} from "@/lib/finance-monthly-fact-backfill";
import { isMonthKey } from "@/lib/finance-monthly-facts";
import { getLatestFinanceSyncRun } from "@/lib/finance-sync-storage";
import logger from "@/lib/logger";

interface BackfillRequestBody {
  fromMonth?: unknown;
  maxChunks?: unknown;
}

function parseBody(body: BackfillRequestBody): {
  fromMonth: string | null;
  maxChunks: number;
} {
  const fromMonth =
    typeof body.fromMonth === "string" && body.fromMonth.trim()
      ? body.fromMonth.trim()
      : null;
  if (fromMonth && !isMonthKey(fromMonth)) {
    throw new Error("fromMonth must be a YYYY-MM month key");
  }

  const maxChunks =
    body.maxChunks === undefined || body.maxChunks === null
      ? DEFAULT_FINANCE_BACKFILL_MAX_CHUNKS
      : Number(body.maxChunks);
  if (!Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new Error("maxChunks must be a positive integer");
  }

  return { fromMonth, maxChunks };
}

export async function POST(request: NextRequest) {
  const authResult = await requireFinanceManagerApiAccess();
  if (!authResult.ok) {
    return authResult.response;
  }

  let options: { fromMonth: string | null; maxChunks: number };
  try {
    const body = request.headers.get("content-type")?.includes("application/json")
      ? ((await request.json()) as BackfillRequestBody)
      : {};
    options = parseBody(body ?? {});
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request body" },
      { status: 400 }
    );
  }

  // One finance sync at a time: replacing fact months while the daily sync is
  // also writing them serves no one.
  const latestRun = await getLatestFinanceSyncRun();
  if (latestRun?.status === FinanceSyncRunStatus.RUNNING) {
    return NextResponse.json(
      {
        error: "A finance sync run is already in progress",
        runId: latestRun.id,
        workflow: latestRun.workflow,
        startedAt: latestRun.startedAt.toISOString(),
      },
      { status: 409 }
    );
  }

  try {
    const execution = await backfillFinanceMonthlyFacts({
      requestedByMemberId: authResult.member.id,
      fromMonth: options.fromMonth,
      maxChunks: options.maxChunks,
      metadata: { initiatedFrom: "/api/finance/sync/backfill-monthly-facts" },
    });

    const auditRequest = getAuditRequestContext(request) ?? {};
    await createAuditLog({
      action: "finance_monthly_facts.backfill",
      memberId: authResult.member.id,
      actorMemberId: authResult.member.id,
      category: "xero",
      severity: "important",
      outcome:
        execution.status === FinanceSyncRunStatus.SUCCEEDED
          ? "success"
          : "blocked",
      summary: "Finance monthly fact table backfill run",
      metadata: {
        runId: execution.runId,
        status: execution.status,
        snapshotCount: execution.snapshotCount,
        totalRowCount: execution.totalRowCount,
        fromMonth: options.fromMonth,
        maxChunks: options.maxChunks,
      },
      requestId: auditRequest.id ?? null,
      ipAddress: auditRequest.ipAddress ?? null,
      userAgent: auditRequest.userAgent ?? null,
    });

    return NextResponse.json({
      runId: execution.runId,
      status: execution.status,
      snapshotCount: execution.snapshotCount,
      totalRowCount: execution.totalRowCount,
      datasetResults: execution.datasetResults,
    });
  } catch (error) {
    logger.error({ err: error }, "Finance monthly fact backfill failed");

    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Finance monthly fact backfill failed",
      },
      { status: 500 }
    );
  }
}
