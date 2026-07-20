import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateAdminPaymentInvoice } from "@/lib/admin-payment-invoice-service";
import { requireAdmin } from "@/lib/session-guards";

const paramsSchema = z.object({
  id: z.string().min(1),
});

function forbiddenResponse() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * POST /api/admin/payments/[id]/generate-invoice
 * Generates a Xero invoice for a payment that doesn't have one.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
    unauthenticatedResponse: forbiddenResponse,
    forbiddenResponse,
  });
  if (!guard.ok) return guard.response;

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid route parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await generateAdminPaymentInvoice({
    paymentId: parsed.data.id,
    adminMemberId: guard.session.user.id,
  });
  return NextResponse.json(result.body, result.init);
}
