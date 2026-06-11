import { NextRequest, NextResponse } from "next/server";
import logger from "@/lib/logger";
import {
  MembershipCancellationRequestError,
  reissueParticipantConfirmationToken,
} from "@/lib/membership-cancellation-requests";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ requestId: string; participantId: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { requestId, participantId } = await params;

  try {
    const result = await reissueParticipantConfirmationToken({
      requestId,
      participantId,
      adminMemberId: session.user.id,
      ipAddress: getClientIp(request),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MembershipCancellationRequestError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }

    logger.error(
      { err, requestId, participantId },
      "Failed to reissue membership cancellation confirmation token",
    );
    return NextResponse.json(
      { error: "Failed to reissue confirmation token" },
      { status: 500 },
    );
  }
}
