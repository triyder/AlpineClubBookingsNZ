import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import logger from "@/lib/logger";
import { requireAdmin } from "@/lib/session-guards";
import {
  applyManualSubscriptionPayment,
  ManualSubscriptionPaymentError,
  MANUAL_PAYMENT_NOTE_MAX,
} from "@/lib/manual-subscription-payment";

const bodySchema = z
  .object({
    direction: z.enum(["paid", "unpaid"]),
    note: z.string().max(MANUAL_PAYMENT_NOTE_MAX).optional().nullable(),
    // Explicit confirmation so a manual money-state change is never a
    // single-click accident.
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/admin/subscriptions/[id]/manual-payment
 *
 * Manually mark a member subscription paid (direction: "paid") or reverse a
 * prior manual mark-paid (direction: "unpaid"). Gated finance:edit. Audited.
 * NEVER calls Xero and NEVER creates or voids an invoice.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "edit" },
  });
  if (!guard.ok) return guard.response;

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid manual payment request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await applyManualSubscriptionPayment({
      subscriptionId: id,
      direction: parsed.data.direction,
      note: parsed.data.note ?? null,
      actingMemberId: guard.session.user.id,
    });
    revalidatePath("/admin/subscriptions");
    revalidatePath("/admin/members/[id]", "page");
    return NextResponse.json({
      success: true,
      subscription: result,
      message:
        result.direction === "paid"
          ? "Subscription marked paid."
          : "Manual payment reversed.",
    });
  } catch (error) {
    if (error instanceof ManualSubscriptionPaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logger.error({ err: error, subscriptionId: id }, "Manual subscription payment failed");
    return NextResponse.json(
      { error: "Manual subscription payment failed." },
      { status: 500 },
    );
  }
}
