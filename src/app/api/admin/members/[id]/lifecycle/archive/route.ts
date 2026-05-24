import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  createMemberArchiveRequest,
  MemberLifecycleActionError,
} from "@/lib/member-lifecycle-actions";
import logger from "@/lib/logger";
import { getClientIp } from "@/lib/rate-limit";
import { requireActiveSessionUser } from "@/lib/session-guards";

const archiveRequestSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
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

  let body: z.infer<typeof archiveRequestSchema>;
  try {
    body = archiveRequestSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { id } = await params;

  try {
    const result = await createMemberArchiveRequest({
      memberId: id,
      requestedByMemberId: session.user.id,
      reason: body.reason,
      ipAddress: getClientIp(request),
    });

    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MemberLifecycleActionError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.statusCode },
      );
    }

    logger.error({ err, memberId: id }, "Failed to create member archive request");
    return NextResponse.json(
      { error: "Failed to create member archive request" },
      { status: 500 },
    );
  }
}
