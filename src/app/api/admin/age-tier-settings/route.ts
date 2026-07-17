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
        sortOrder: z.number().int().min(0),
      })
    )
    .min(1),
});

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
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
      sortOrder: true,
    },
  });

  return NextResponse.json({ settings: normalizeAgeTierSettings(settings) });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
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
          sortOrder: s.sortOrder,
        },
        create: {
          tier: s.tier,
          minAge: s.minAge,
          maxAge: s.maxAge,
          label: s.label,
          subscriptionRequiredForBooking: s.subscriptionRequiredForBooking,
          familyGroupRequestCreateMemberAllowed:
            s.familyGroupRequestCreateMemberAllowed,
          sortOrder: s.sortOrder,
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
      sortOrder: true,
    },
  });

  revalidatePublicPageContent();
  return NextResponse.json({ settings: normalizeAgeTierSettings(updated) });
}
