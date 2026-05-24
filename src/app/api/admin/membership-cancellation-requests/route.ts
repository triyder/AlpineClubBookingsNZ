import { MembershipCancellationRequestStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  getAdminMembershipCancellationRequests,
  type AdminCancellationStatusFilter,
} from "@/lib/membership-cancellation-admin";
import logger from "@/lib/logger";
import { requireActiveSessionUser } from "@/lib/session-guards";

const querySchema = z.object({
  status: z
    .enum([
      MembershipCancellationRequestStatus.REQUESTED,
      MembershipCancellationRequestStatus.APPROVED,
      MembershipCancellationRequestStatus.REJECTED,
      MembershipCancellationRequestStatus.WITHDRAWN,
      MembershipCancellationRequestStatus.COMPLETED,
      "ALL",
    ])
    .optional()
    .default(MembershipCancellationRequestStatus.REQUESTED),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const data = await getAdminMembershipCancellationRequests({
      status: parsed.data.status as AdminCancellationStatusFilter,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    });

    return NextResponse.json({
      data: data.requests,
      requests: data.requests,
      pendingCount: data.pendingCount,
      total: data.total,
      page: data.page,
      pageSize: data.pageSize,
      totalPages: data.totalPages,
    });
  } catch (err) {
    logger.error({ err }, "Failed to load membership cancellation requests");
    return NextResponse.json(
      { error: "Failed to load membership cancellation requests" },
      { status: 500 },
    );
  }
}
