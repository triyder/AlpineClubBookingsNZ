import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  MemberLifecycleActionError,
  reviewMemberLifecycleActionRequest,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireAdmin } from "@/lib/session-guards";

const reviewSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().max(1000).optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  let body: z.infer<typeof reviewSchema>;
  try {
    body = reviewSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { requestId } = await params;

  try {
    const result = await reviewMemberLifecycleActionRequest({
      requestId,
      reviewedByMemberId: session.user.id,
      action: body.action,
      reviewNote: body.note,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MemberLifecycleActionError) {
      return NextResponse.json(
        { error: err.message, details: err.details },
        { status: err.statusCode },
      );
    }

    logger.error({ err, requestId }, "Failed to review member lifecycle action request");
    return NextResponse.json(
      { error: "Failed to review member lifecycle action request" },
      { status: 500 },
    );
  }
}
