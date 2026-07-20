import { NextRequest, NextResponse } from "next/server";
import {
  listAdminFamilyGroupRequests,
  reviewAdminFamilyGroupRequest,
  reviewFamilyGroupRequestSchema,
} from "@/lib/admin-family-group-requests-service";
import { requireAdmin } from "@/lib/session-guards";

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

/**
 * GET /api/admin/family-groups/requests
 * List pending family group change requests.
 */
export async function GET() {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const result = await listAdminFamilyGroupRequests();
  return NextResponse.json(result.body, result.init);
}

/**
 * PUT /api/admin/family-groups/requests
 * Approve or reject a family group change request.
 */
export async function PUT(req: NextRequest) {
  const guard = await requireAdmin({
    ...adminGuardOptions,
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = reviewFamilyGroupRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const result = await reviewAdminFamilyGroupRequest({
    adminMemberId: guard.session.user.id,
    data: parsed.data,
  });
  return NextResponse.json(result.body, result.init);
}
