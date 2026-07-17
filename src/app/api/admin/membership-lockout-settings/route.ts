import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  getFinancialYearResolution,
  refreshFinancialYearConfig,
} from "@/lib/financial-year-server";
import {
  MEMBERSHIP_LOCKOUT_SETTINGS_ID,
  loadPersistedMembershipLockoutSettings,
  normalizeMembershipLockoutSettings,
} from "@/lib/membership-lockout-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    financialYearEndMonthOverride: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullable()
      .optional(),
    textFallbackEnabled: z.boolean().optional(),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const persisted = await loadPersistedMembershipLockoutSettings();
  const financialYear = await getFinancialYearResolution();
  return NextResponse.json({
    settings: normalizeMembershipLockoutSettings(persisted),
    financialYear,
    persisted,
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const before = await prisma.membershipLockoutSettings.findUnique({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
  });

  const data = {
    enabled: parsed.data.enabled ?? before?.enabled ?? true,
    financialYearEndMonthOverride:
      parsed.data.financialYearEndMonthOverride !== undefined
        ? parsed.data.financialYearEndMonthOverride
        : (before?.financialYearEndMonthOverride ?? null),
    textFallbackEnabled:
      parsed.data.textFallbackEnabled ?? before?.textFallbackEnabled ?? true,
    updatedByMemberId: session.user.id,
  };

  const record = await prisma.membershipLockoutSettings.upsert({
    where: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID },
    create: { id: MEMBERSHIP_LOCKOUT_SETTINGS_ID, ...data },
    update: data,
  });

  // Reseed the financial-year cache so the change takes effect immediately on
  // this instance.
  await refreshFinancialYearConfig();

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "MEMBERSHIP_LOCKOUT_SETTINGS_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "MembershipLockoutSettings",
        id: MEMBERSHIP_LOCKOUT_SETTINGS_ID,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Membership booking lockout settings updated",
      metadata: { previousSettings: before, newSettings: data },
      request: getAuditRequestContext(request),
    })
  );

  const financialYear = await getFinancialYearResolution();
  return NextResponse.json({
    settings: normalizeMembershipLockoutSettings(record),
    financialYear,
    persisted: record,
  });
}
