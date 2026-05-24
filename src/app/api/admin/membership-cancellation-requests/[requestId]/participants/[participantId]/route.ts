import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  MembershipCancellationAdminError,
  reviewMembershipCancellationParticipant,
} from "@/lib/membership-cancellation-admin";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
});

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ requestId: string; participantId: string }> },
) {
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

  let body: z.infer<typeof reviewSchema>;
  try {
    body = reviewSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { requestId, participantId } = await params;

  try {
    const result = await reviewMembershipCancellationParticipant({
      requestId,
      participantId,
      action: body.action,
      adminMemberId: session.user.id,
      adminNote: body.note,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MembershipCancellationAdminError) {
      return NextResponse.json(
        { error: err.message, ...(err.details ?? {}) },
        { status: err.statusCode },
      );
    }

    logger.error(
      { err, requestId, participantId },
      "Failed to review membership cancellation participant",
    );
    return NextResponse.json(
      { error: "Failed to review membership cancellation participant" },
      { status: 500 },
    );
  }
}
