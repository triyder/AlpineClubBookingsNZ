import { revalidatePath } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import { DEFAULT_FAMILY_BILLING_MODE, FAMILY_BILLING_MODES } from "@/lib/authoritative-fees";
import { getTodayDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import {
  buildSubscriptionBillingPreview,
  confirmSubscriptionBillingPreview,
} from "@/lib/membership-subscription-billing";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import { getSeasonYear } from "@/lib/utils";
import { enqueueMembershipSubscriptionChargeOperation } from "@/lib/xero-subscription-invoices";

const querySchema = z.object({
  seasonYear: z.coerce.number().int().min(2020).max(2040).optional(),
  decisionDate: z.string().optional(),
});
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CONFIRM_ANNUAL_BATCH"),
    seasonYear: z.number().int().min(2020).max(2040),
    decisionDate: z.string(),
    confirmationToken: z.string().length(64),
    confirmed: z.literal(true),
  }).strict(),
  z.object({ action: z.literal("RETRY_CHARGE"), chargeId: z.string().min(1) }).strict(),
  z.object({
    action: z.literal("UPDATE_SETTINGS"),
    invoiceDueDays: z.number().int().min(1).max(365),
    // Optional so the existing due-days save path stays a single-field write;
    // when present it switches the club-level family billing model.
    familyBillingMode: z.enum(FAMILY_BILLING_MODES).optional(),
  }).strict(),
]);

function invalidate() {
  revalidatePath("/admin/subscriptions");
  revalidatePath("/admin/stuck-states");
  revalidatePath("/admin/members/[id]", "page");
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid billing preview query." }, { status: 400 });
  const decisionDate = parsed.data.decisionDate
    ? (isDateOnlyString(parsed.data.decisionDate) ? parseDateOnly(parsed.data.decisionDate) : null)
    : getTodayDateOnly();
  if (!decisionDate) return NextResponse.json({ error: "Decision date must be YYYY-MM-DD." }, { status: 400 });
  const seasonYear = parsed.data.seasonYear ?? getSeasonYear(decisionDate);
  try {
    const [preview, charges, exceptions, settings] = await Promise.all([
      buildSubscriptionBillingPreview({ seasonYear, decisionDate }),
      prisma.membershipSubscriptionCharge.findMany({
        where: { seasonYear },
        orderBy: { createdAt: "desc" },
        take: 100,
        include: { coverage: { select: { memberId: true, memberName: true } } },
      }),
      prisma.membershipBillingException.findMany({
        where: { seasonYear, status: "OPEN" },
        orderBy: { lastSeenAt: "desc" },
        take: 100,
      }),
      prisma.membershipSubscriptionBillingSettings.findUnique({ where: { id: "default" } }),
    ]);
    const previewFingerprints = new Set(preview.exceptions.map((item) => item.fingerprint));
    const visiblePersistentExceptions = exceptions.filter(
      (item) => !previewFingerprints.has(item.fingerprint)
    );
    return NextResponse.json({
      preview,
      charges,
      exceptions: visiblePersistentExceptions,
      settings: {
        invoiceDueDays: settings?.invoiceDueDays ?? 30,
        familyBillingMode: settings?.familyBillingMode ?? DEFAULT_FAMILY_BILLING_MODE,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not build subscription billing preview." }, { status: 409 });
  }
}

export async function POST(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid subscription billing action.", details: parsed.error.flatten() }, { status: 400 });
  try {
    if (parsed.data.action === "UPDATE_SETTINGS") {
      const action = parsed.data;
      // Only write familyBillingMode when the client sent it, so a plain
      // due-days save never disturbs the mode (and vice versa). A create falls
      // back to the schema default when the mode is absent.
      const settingsFields = {
        invoiceDueDays: action.invoiceDueDays,
        ...(action.familyBillingMode ? { familyBillingMode: action.familyBillingMode } : {}),
        updatedByMemberId: guard.session.user.id,
      };
      await prisma.$transaction(async (tx) => {
        await tx.membershipSubscriptionBillingSettings.upsert({
          where: { id: "default" },
          update: settingsFields,
          create: { id: "default", ...settingsFields },
        });
        await createAuditLog({
          action: "membership-subscription-billing.settings.update",
          memberId: guard.session.user.id,
          targetId: "default",
          details: JSON.stringify({
            invoiceDueDays: action.invoiceDueDays,
            ...(action.familyBillingMode ? { familyBillingMode: action.familyBillingMode } : {}),
          }),
        }, tx);
      });
      invalidate();
      return NextResponse.json({
        success: true,
        message: action.familyBillingMode ? "Subscription billing settings updated." : "Subscription invoice due days updated.",
      });
    }
    if (parsed.data.action === "RETRY_CHARGE") {
      const result = await enqueueMembershipSubscriptionChargeOperation(parsed.data.chargeId, { createdByMemberId: guard.session.user.id });
      await createAuditLog({
        action: "membership-subscription-billing.retry",
        memberId: guard.session.user.id,
        targetId: parsed.data.chargeId,
        details: JSON.stringify(result),
      });
      invalidate();
      return NextResponse.json({ success: true, ...result });
    }
    if (!isDateOnlyString(parsed.data.decisionDate)) {
      return NextResponse.json({ error: "Decision date must be YYYY-MM-DD." }, { status: 400 });
    }
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: parsed.data.seasonYear,
      decisionDate: parseDateOnly(parsed.data.decisionDate),
    });
    if (preview.confirmationToken !== parsed.data.confirmationToken) {
      return NextResponse.json({ error: "Billing configuration changed after preview. Review the refreshed preview before confirming." }, { status: 409 });
    }
    const result = await confirmSubscriptionBillingPreview({
      preview,
      expectedConfirmationToken: parsed.data.confirmationToken,
      source: "ANNUAL_BATCH",
      confirmedByMemberId: guard.session.user.id,
    });
    const queued = await Promise.all(result.chargeIds.map((chargeId) =>
      enqueueMembershipSubscriptionChargeOperation(chargeId, { createdByMemberId: guard.session.user.id })));
    invalidate();
    return NextResponse.json({
      success: true,
      message: `${result.chargeIds.length} immutable charge${result.chargeIds.length === 1 ? "" : "s"} created; ${result.exceptionCount} exception${result.exceptionCount === 1 ? "" : "s"} recorded.`,
      ...result,
      queued,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Subscription billing action failed." }, { status: 409 });
  }
}
