import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { logAudit } from "@/lib/audit";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import {
  AGE_TIER_DEFAULTS,
  invalidateAgeTierCache,
  normalizeAgeTierSettings,
} from "@/lib/age-tier";

type AgeTierSettingInput = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  xeroContactGroupId: string | null;
  xeroContactGroupName: string | null;
  xeroAcceptedContactGroups: Array<{
    groupId: string;
    groupName: string | null;
  }>;
  sortOrder: number;
};

const putSchema = z.object({
  settings: z
    .array(
      z.object({
        // NOT_APPLICABLE is the organisation/school tier (#1440): it has no
        // age range, no Xero group, and no subscription rule, so it never
        // gets a settings row.
        tier: ageTierEnum.refine((tier) => tier !== "NOT_APPLICABLE", {
          message: "The N/A age tier is not configurable",
        }),
        minAge: z.number().int().min(0),
        maxAge: z.number().int().min(0).nullable(),
        label: z.string().min(1).max(100),
        subscriptionRequiredForBooking: z.boolean(),
        familyGroupRequestCreateMemberAllowed: z.boolean(),
        xeroContactGroupId: z.string().trim().min(1).max(100).nullable().optional(),
        xeroContactGroupName: z.string().trim().min(1).max(255).nullable().optional(),
        xeroAcceptedContactGroups: z
          .array(
            z.object({
              groupId: z.string().trim().min(1).max(100),
              groupName: z.string().trim().min(1).max(255).nullable().optional(),
            })
          )
          .optional(),
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const settings = await prisma.ageTierSetting.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      tier: true,
      minAge: true,
      maxAge: true,
      label: true,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: true,
      xeroContactGroupId: true,
      xeroContactGroupName: true,
      xeroAcceptedContactGroups: {
        orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        select: {
          groupId: true,
          groupName: true,
        },
      },
      sortOrder: true,
    },
  });

  return NextResponse.json({ settings: normalizeAgeTierSettings(settings) });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await request.json();
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const settings: AgeTierSettingInput[] = parsed.data.settings.map((setting) => ({
    ...setting,
    tier: setting.tier as AgeTier,
    xeroContactGroupId: setting.xeroContactGroupId?.trim() || null,
    xeroContactGroupName:
      setting.xeroContactGroupId?.trim()
        ? setting.xeroContactGroupName?.trim() || null
        : null,
    xeroAcceptedContactGroups: Array.from(
      new Map(
        (setting.xeroAcceptedContactGroups ?? []).map((group) => [
          group.groupId.trim(),
          {
            groupId: group.groupId.trim(),
            groupName: group.groupName?.trim() || null,
          },
        ])
      ).values()
    ).filter((group) => group.groupId.length > 0),
  }));
  const requiredTiers = new Set(AGE_TIER_DEFAULTS.map((setting) => setting.tier));
  const providedTiers = new Set(settings.map((setting) => setting.tier));

  if (
    settings.length !== requiredTiers.size ||
    providedTiers.size !== requiredTiers.size ||
    [...requiredTiers].some((tier) => !providedTiers.has(tier))
  ) {
    return NextResponse.json(
      {
        error: `Age tier settings must include each tier exactly once: ${[...requiredTiers].join(", ")}`,
      },
      { status: 400 }
    );
  }

  // Validate: tiers must be contiguous — no gaps or overlaps
  const sorted = [...settings].sort((a, b) => a.minAge - b.minAge);
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (current.maxAge === null) {
      return NextResponse.json(
        { error: "Only the highest tier (ADULT) can have no upper age limit" },
        { status: 400 }
      );
    }
    if (current.maxAge + 1 !== next.minAge) {
      return NextResponse.json(
        {
          error: `Age boundaries must be contiguous: gap or overlap between maxAge ${current.maxAge} and minAge ${next.minAge}`,
        },
        { status: 400 }
      );
    }
  }

  // ADULT must have maxAge = null
  const adult = settings.find((s) => s.tier === "ADULT");
  if (adult && adult.maxAge !== null) {
    return NextResponse.json(
      { error: "ADULT tier must have no upper age limit (maxAge must be null)" },
      { status: 400 }
    );
  }

  const assignedGroupIds = new Map<
    string,
    {
      tier: AgeTier;
      kind: "primary" | "accepted";
    }
  >();
  for (const setting of settings) {
    if (setting.xeroAcceptedContactGroups.length > 0 && !setting.xeroContactGroupId) {
      return NextResponse.json(
        {
          error:
            "Each age tier needs a primary Xero contact group before additional accepted groups can be added.",
        },
        { status: 400 }
      );
    }

    if (setting.xeroContactGroupId) {
      const existing = assignedGroupIds.get(setting.xeroContactGroupId);
      if (existing) {
        return NextResponse.json(
          {
            error: `Xero contact group ${setting.xeroContactGroupName ?? setting.xeroContactGroupId} is already assigned to ${existing.tier}. Each Xero contact group can only belong to one age tier.`,
          },
          { status: 400 }
        );
      }

      assignedGroupIds.set(setting.xeroContactGroupId, {
        tier: setting.tier,
        kind: "primary",
      });
    }

    for (const group of setting.xeroAcceptedContactGroups) {
      if (group.groupId === setting.xeroContactGroupId) {
        return NextResponse.json(
          {
            error:
              "A primary Xero contact group cannot also be listed as an accepted additional group for the same age tier.",
          },
          { status: 400 }
        );
      }

      const existing = assignedGroupIds.get(group.groupId);
      if (existing) {
        return NextResponse.json(
          {
            error: `Xero contact group ${group.groupName ?? group.groupId} is already assigned to ${existing.tier}. Each Xero contact group can only belong to one age tier.`,
          },
          { status: 400 }
        );
      }

      assignedGroupIds.set(group.groupId, {
        tier: setting.tier,
        kind: "accepted",
      });
    }
  }

  await prisma.$transaction(
    settings.map((s) =>
      prisma.ageTierSetting.upsert({
        where: { tier: s.tier },
        update: {
          minAge: s.minAge,
          maxAge: s.maxAge,
          label: s.label,
          subscriptionRequiredForBooking: s.subscriptionRequiredForBooking,
          familyGroupRequestCreateMemberAllowed:
            s.familyGroupRequestCreateMemberAllowed,
          xeroContactGroupId: s.xeroContactGroupId,
          xeroContactGroupName: s.xeroContactGroupName,
          sortOrder: s.sortOrder,
          xeroAcceptedContactGroups: {
            deleteMany: {},
            create: s.xeroAcceptedContactGroups.map((group) => ({
              groupId: group.groupId,
              groupName: group.groupName,
            })),
          },
        },
        create: {
          tier: s.tier,
          minAge: s.minAge,
          maxAge: s.maxAge,
          label: s.label,
          subscriptionRequiredForBooking: s.subscriptionRequiredForBooking,
          familyGroupRequestCreateMemberAllowed:
            s.familyGroupRequestCreateMemberAllowed,
          xeroContactGroupId: s.xeroContactGroupId,
          xeroContactGroupName: s.xeroContactGroupName,
          sortOrder: s.sortOrder,
          xeroAcceptedContactGroups: {
            create: s.xeroAcceptedContactGroups.map((group) => ({
              groupId: group.groupId,
              groupName: group.groupName,
            })),
          },
        },
      })
    )
  );

  // Invalidate cache so next computeAgeTier reads fresh values
  invalidateAgeTierCache();

  await logAudit({
    action: "AGE_TIER_SETTINGS_UPDATED",
    memberId: session.user.id,
    details: JSON.stringify(settings),
  });

  const updated = await prisma.ageTierSetting.findMany({
    orderBy: { sortOrder: "asc" },
    select: {
      tier: true,
      minAge: true,
      maxAge: true,
      label: true,
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: true,
      xeroContactGroupId: true,
      xeroContactGroupName: true,
      xeroAcceptedContactGroups: {
        orderBy: [{ groupName: "asc" }, { groupId: "asc" }],
        select: {
          groupId: true,
          groupName: true,
        },
      },
      sortOrder: true,
    },
  });

  revalidatePublicPageContent();
  return NextResponse.json({ settings: normalizeAgeTierSettings(updated) });
}
