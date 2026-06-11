import { after, NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import { getXeroApiErrorInfo } from "@/lib/xero-api-errors";
import {
  enqueueXeroSyncOperationRetry,
  processQueuedXeroOperationRetries,
} from "@/lib/xero-operation-queue";
import { XeroOperationRetryError } from "@/lib/xero-operation-retry";

function scheduleAfterResponse(task: () => Promise<void>) {
  try {
    after(task);
  } catch {
    queueMicrotask(() => {
      void task();
    });
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id } = await params;

  try {
    const result = await enqueueXeroSyncOperationRetry(id, {
      createdByMemberId: session.user.id,
    });

    await logAudit({
      action: "XERO_OPERATION_RETRY",
      memberId: session.user.id,
      targetId: id,
      details: result.message,
    });

    scheduleAfterResponse(async () => {
      try {
        await processQueuedXeroOperationRetries({ limit: 1 });
      } catch (error) {
        logger.error(
          { err: error, operationId: id },
          "Failed to kick queued Xero retry worker"
        );
      }
    });

    return NextResponse.json(
      {
        ok: true,
        message: result.message,
        queueOperationId: result.queueOperationId,
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof XeroOperationRetryError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    const xeroError = getXeroApiErrorInfo(
      error,
      "Failed to queue Xero operation retry"
    );
    logger.error({ err: error, operationId: id }, "Failed to queue Xero retry");

    return NextResponse.json(
      { error: xeroError.message },
      { status: xeroError.handled ? xeroError.status : 500 }
    );
  }
}
