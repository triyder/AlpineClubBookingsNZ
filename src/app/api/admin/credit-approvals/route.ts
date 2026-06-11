import { NextRequest, NextResponse } from "next/server";
import { AdminCreditAdjustmentRequestStatus } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { getAdminAdjustmentRequests } from "@/lib/member-credit";

const allowedStatuses = new Set([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "ALL",
] as const);

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const requestedStatus = (searchParams.get("status") ?? "PENDING").toUpperCase();
  const status = allowedStatuses.has(
    requestedStatus as "PENDING" | "APPROVED" | "REJECTED" | "ALL"
  )
    ? (requestedStatus as
        | AdminCreditAdjustmentRequestStatus
        | "ALL")
    : AdminCreditAdjustmentRequestStatus.PENDING;

  const requests = await getAdminAdjustmentRequests(status);

  return NextResponse.json(requests);
}
