import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import type { AgeTier } from "@prisma/client";
import { z } from "zod";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { logAudit } from "@/lib/audit";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";
import {
  invalidateAgeTierCache,
  normalizeAgeTierSettings,
  validateAgeTierPartition,
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

  // --- Validity rule (issue #2009 — interim age-tier subset relaxation) -------
  // A club may save ANY subset of the bookable AgeTier slots (not just all four),
  // provided the saved rows still form a single, complete, non-overlapping
  // partition of [0, ∞) with ADULT as the unbounded terminal tier. The exact rule
  // (≥1 tier, no duplicate slot, ADULT present + the only unbounded tier, ranges
  // tile 0 → ∞ with no gaps/overlaps) lives in `validateAgeTierPartition` so it is
  // pure and unit-testable. Which enum identities make up the subset is otherwise
  // free (e.g. CHILD 0-17 + ADULT 18+ legally skips INFANT and YOUTH; ADULT-only
  // 0+ is legal). The canonical all-four TAC install still satisfies every clause,
  // so its behaviour is byte-unchanged.
  const validation = validateAgeTierPartition(settings);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const sorted = validation.sorted;

  // Re-index sortOrder to a canonical, gap-free 0..n-1 in ascending-age order.
  // Every consumer that orders by sortOrder (computeAgeTierWithSettings, the
  // admin UI's next-tier maxAge derivation, normalizeAgeTierSettings) then sees
  // the same age-ascending sequence regardless of the sortOrder values the client
  // sent. It also keeps a saved subset clear of the legacy-3-tier auto-migration
  // shape, which is pinned to sortOrder 1/2/3 (see isLegacyThreeTierSettings):
  // a subset saved here always uses 0-based sortOrders, so a deliberate
  // CHILD/YOUTH/ADULT subset is never mistaken for an unmigrated legacy DB. The
  // canonical four-tier save already sends 0,1,2,3 in age order, so this is a
  // no-op for it (behaviour byte-unchanged).
  const normalizedSettings = sorted.map((s, index) => ({
    ...s,
    sortOrder: index,
  }));

  // --- Tier removal safety (issue #2009) -------------------------------------
  // A subset save may DROP tiers that previously existed in the table. Deleting a
  // tier row while a live person still classifies into it would orphan their
  // stored ageTier (no matching AgeTierSetting row → wrong label / price / Xero
  // group), so we fail CLOSED: a tier can only be removed when no non-archived
  // member and no current-or-upcoming booking guest is still classified into it.
  // Past booking guests are frozen historical snapshots and never re-priced, so
  // they do not block. The admin must first reclassify any live people (e.g.
  // widen an adjacent tier to absorb the range) before the tier can be dropped.
  const existingTiers = await prisma.ageTierSetting.findMany({
    select: { tier: true },
  });
  const keptTiers = new Set(normalizedSettings.map((s) => s.tier));
  const removedTiers = existingTiers
    .map((row) => row.tier)
    .filter((tier) => !keptTiers.has(tier));

  if (removedTiers.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [membersInRemoved, liveGuestsInRemoved] = await Promise.all([
      prisma.member.count({
        where: { ageTier: { in: removedTiers }, archivedAt: null },
      }),
      prisma.bookingGuest.count({
        where: { ageTier: { in: removedTiers }, stayEnd: { gte: today } },
      }),
    ]);
    if (membersInRemoved > 0 || liveGuestsInRemoved > 0) {
      const plural = removedTiers.length > 1;
      return NextResponse.json(
        {
          error:
            `Cannot remove age tier${plural ? "s" : ""} ${removedTiers.join(", ")}: ` +
            `${membersInRemoved} active member(s) and ${liveGuestsInRemoved} ` +
            `current or upcoming booking guest(s) are still classified into ` +
            `${plural ? "them" : "it"}. Reclassify those people (for example by ` +
            `widening an adjacent tier to cover their ages) before removing ` +
            `${plural ? "these tiers" : "this tier"}.`,
        },
        { status: 409 }
      );
    }
  }

  const upsertOps = normalizedSettings.map((s) =>
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
  );

  // Drop any tiers no longer in the saved set (guarded above so no live person
  // is classified into them). Deleting the row cascades its Xero group aliases
  // (AgeTierXeroAcceptedContactGroup). Runs in the same transaction as the
  // upserts so the table is never left in a partial state.
  const ops =
    removedTiers.length > 0
      ? [
          prisma.ageTierSetting.deleteMany({
            where: { tier: { in: removedTiers } },
          }),
          ...upsertOps,
        ]
      : upsertOps;

  await prisma.$transaction(ops);

  // Invalidate cache so next computeAgeTier reads fresh values
  invalidateAgeTierCache();

  await logAudit({
    action: "AGE_TIER_SETTINGS_UPDATED",
    memberId: session.user.id,
    details: JSON.stringify({ settings: normalizedSettings, removedTiers }),
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
