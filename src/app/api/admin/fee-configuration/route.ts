import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createAuditLog } from "@/lib/audit";
import {
  ENTRANCE_FEE_CATEGORIES,
  FeeScheduleValidationError,
  MEMBERSHIP_FEE_BILLING_BASES,
  MEMBERSHIP_FEE_PRORATION_RULES,
  getEffectiveEntranceFee,
  getFamilyBillingMode,
  lockFeeSchedule,
  scheduleOverlapWhere,
  serializeFeeSchedule,
  validateFeeScheduleInput,
} from "@/lib/authoritative-fees";
import { prisma } from "@/lib/prisma";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { requireAdmin } from "@/lib/session-guards";

const dateField = z.string().trim();
const moneyField = z.number().int().min(0).max(2_147_483_647);
const scheduleDates = {
  amountCents: moneyField,
  effectiveFrom: dateField,
  effectiveTo: dateField.nullable().optional(),
};
const mutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("CREATE_MEMBERSHIP_FEE"),
    membershipTypeId: z.string().min(1),
    billingBasis: z.enum(MEMBERSHIP_FEE_BILLING_BASES),
    prorationRule: z.enum(MEMBERSHIP_FEE_PRORATION_RULES),
    ...scheduleDates,
  }).strict(),
  z.object({
    action: z.literal("UPDATE_MEMBERSHIP_FEE"),
    id: z.string().min(1),
    billingBasis: z.enum(MEMBERSHIP_FEE_BILLING_BASES),
    prorationRule: z.enum(MEMBERSHIP_FEE_PRORATION_RULES),
    ...scheduleDates,
  }).strict(),
  z.object({ action: z.literal("DELETE_MEMBERSHIP_FEE"), id: z.string().min(1) }).strict(),
  z.object({
    action: z.literal("CREATE_ENTRANCE_FEE"),
    category: z.enum(ENTRANCE_FEE_CATEGORIES),
    ...scheduleDates,
  }).strict(),
  z.object({
    action: z.literal("UPDATE_ENTRANCE_FEE"),
    id: z.string().min(1),
    ...scheduleDates,
  }).strict(),
  z.object({ action: z.literal("DELETE_ENTRANCE_FEE"), id: z.string().min(1) }).strict(),
  z.object({
    action: z.literal("SET_FAMILY_BILLING_MEMBER"),
    familyGroupId: z.string().min(1),
    billingMemberId: z.string().min(1).nullable(),
  }).strict(),
]);

async function loadConfiguration(canEdit: boolean) {
  const [familyBillingMode, membershipTypes, entranceFees, familyGroups, currentEntranceFees] = await Promise.all([
    getFamilyBillingMode(),
    prisma.membershipType.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: {
        id: true, key: true, name: true, isActive: true,
        annualFees: { orderBy: [{ effectiveFrom: "desc" }], },
      },
    }),
    prisma.entranceFee.findMany({ orderBy: [{ category: "asc" }, { effectiveFrom: "desc" }] }),
    prisma.familyGroup.findMany({
      where: { memberships: { some: {} } },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      select: {
        id: true, name: true, billingMembershipId: true,
        billingMembership: {
          select: {
            familyGroupId: true,
            member: { select: { id: true, firstName: true, lastName: true, email: true, active: true, archivedAt: true } },
          },
        },
        memberships: {
          where: { member: { archivedAt: null } },
          select: { member: { select: { id: true, firstName: true, lastName: true, email: true, active: true, ageTier: true } } },
          orderBy: { member: { firstName: "asc" } },
        },
      },
    }),
    Promise.all(ENTRANCE_FEE_CATEGORIES.map(async (category) => ({
      category,
      ...(await getEffectiveEntranceFee(category)),
    }))),
  ]);
  // Family-billing exceptions only exist when the club bills families via a
  // nominated billing member. When it bills members individually the whole
  // family-billing surface is irrelevant, so no family is ever flagged.
  const familyBillingActive = familyBillingMode === "BILL_FAMILY_VIA_BILLING_MEMBER";
  return {
    canEdit,
    familyBillingMode,
    membershipTypes: membershipTypes.map((type) => ({
      ...type,
      annualFees: type.annualFees.map(serializeFeeSchedule),
    })),
    entranceFees: entranceFees.map(serializeFeeSchedule),
    currentEntranceFees,
    familyGroups: familyGroups.map((group) => ({
      ...group,
      billingMemberId: group.billingMembership?.member.id ?? null,
      billingException: familyBillingActive && (group.billingMembership == null
        || group.billingMembership.familyGroupId !== group.id
        || !group.billingMembership.member.active
        || group.billingMembership.member.archivedAt != null),
      billingMembership: undefined,
      billingMembershipId: undefined,
      members: group.memberships.map(({ member }) => member),
      memberships: undefined,
    })),
  };
}

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "finance", level: "view" } });
  if (!guard.ok) return guard.response;
  return NextResponse.json(await loadConfiguration(
    hasAdminAreaAccess(guard.session.user, { area: "finance", level: "edit" }),
  ));
}

export async function POST(request: Request) {
  const guard = await requireAdmin({ permission: { area: "finance", level: "edit" } });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = mutationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      const input = parsed.data;
      let targetId: string;
      if (input.action === "CREATE_MEMBERSHIP_FEE" || input.action === "UPDATE_MEMBERSHIP_FEE") {
        // Server-side mode gate: per-family billing is only meaningful when the
        // club bills families via a nominated billing member. The UI hides the
        // option, but this guard makes the rule authoritative against direct API
        // calls and cannot be bypassed.
        // A concurrent FAMILY->INDIVIDUALLY flip between this mode read and the
        // commit is backstopped by the billing engine's
        // `PER_FAMILY_FEE_IN_INDIVIDUAL_MODE` preview exception (a stale
        // PER_FAMILY schedule is never invoiced), so the guard need not serialise
        // against the settings row.
        if (input.billingBasis === "PER_FAMILY" && await getFamilyBillingMode(tx) === "BILL_MEMBERS_INDIVIDUALLY") {
          throw new FeeScheduleValidationError(
            "Per-family billing is disabled while this club bills members individually. Change the family billing mode on the subscription billing settings first.",
            409,
          );
        }
        const dates = validateFeeScheduleInput(input);
        const existing = input.action === "UPDATE_MEMBERSHIP_FEE"
          ? await tx.membershipAnnualFee.findUnique({ where: { id: input.id } })
          : null;
        if (input.action === "UPDATE_MEMBERSHIP_FEE" && !existing) throw new FeeScheduleValidationError("Membership fee not found.", 404);
        const membershipTypeId = input.action === "CREATE_MEMBERSHIP_FEE" ? input.membershipTypeId : existing!.membershipTypeId;
        if (!await tx.membershipType.findUnique({ where: { id: membershipTypeId }, select: { id: true } })) {
          throw new FeeScheduleValidationError("Membership type not found.", 404);
        }
        await lockFeeSchedule(tx, "membership", membershipTypeId);
        const overlap = await tx.membershipAnnualFee.findFirst({
          where: { membershipTypeId, ...scheduleOverlapWhere({ ...dates, excludeId: existing?.id }) }, select: { id: true },
        });
        if (overlap) throw new FeeScheduleValidationError("This membership fee overlaps an existing effective-date range.", 409);
        const row = existing
          ? await tx.membershipAnnualFee.update({ where: { id: existing.id }, data: { ...dates, billingBasis: input.billingBasis, prorationRule: input.prorationRule } })
          : await tx.membershipAnnualFee.create({ data: { membershipTypeId, ...dates, billingBasis: input.billingBasis, prorationRule: input.prorationRule } });
        targetId = row.id;
      } else if (input.action === "CREATE_ENTRANCE_FEE" || input.action === "UPDATE_ENTRANCE_FEE") {
        const dates = validateFeeScheduleInput(input);
        const existing = input.action === "UPDATE_ENTRANCE_FEE"
          ? await tx.entranceFee.findUnique({ where: { id: input.id } })
          : null;
        if (input.action === "UPDATE_ENTRANCE_FEE" && !existing) throw new FeeScheduleValidationError("Entrance fee not found.", 404);
        const category = input.action === "CREATE_ENTRANCE_FEE" ? input.category : existing!.category;
        await lockFeeSchedule(tx, "entrance", category);
        const overlap = await tx.entranceFee.findFirst({
          where: { category, ...scheduleOverlapWhere({ ...dates, excludeId: existing?.id }) }, select: { id: true },
        });
        if (overlap) throw new FeeScheduleValidationError("This entrance fee overlaps an existing effective-date range.", 409);
        const row = existing
          ? await tx.entranceFee.update({ where: { id: existing.id }, data: dates })
          : await tx.entranceFee.create({ data: { category, ...dates } });
        targetId = row.id;
      } else if (input.action === "DELETE_MEMBERSHIP_FEE") {
        const existing = await tx.membershipAnnualFee.findUnique({ where: { id: input.id } });
        if (!existing) throw new FeeScheduleValidationError("Membership fee not found.", 404);
        await lockFeeSchedule(tx, "membership", existing.membershipTypeId);
        await tx.membershipAnnualFee.delete({ where: { id: existing.id } });
        targetId = existing.id;
      } else if (input.action === "DELETE_ENTRANCE_FEE") {
        const existing = await tx.entranceFee.findUnique({ where: { id: input.id } });
        if (!existing) throw new FeeScheduleValidationError("Entrance fee not found.", 404);
        await lockFeeSchedule(tx, "entrance", existing.category);
        await tx.entranceFee.delete({ where: { id: existing.id } });
        targetId = existing.id;
      } else {
        const group = await tx.familyGroup.findUnique({ where: { id: input.familyGroupId }, select: { id: true } });
        if (!group) throw new FeeScheduleValidationError("Family group not found.", 404);
        if (input.billingMemberId) {
          const membership = await tx.familyGroupMember.findUnique({
            where: { familyGroupId_memberId: { familyGroupId: input.familyGroupId, memberId: input.billingMemberId } },
            select: { id: true, member: { select: { active: true, archivedAt: true } } },
          });
          if (!membership || !membership.member.active || membership.member.archivedAt) {
            throw new FeeScheduleValidationError("Billing member must be an active, unarchived member of this family.");
          }
          await tx.familyGroup.update({ where: { id: input.familyGroupId }, data: { billingMembershipId: membership.id } });
        } else {
          await tx.familyGroup.update({ where: { id: input.familyGroupId }, data: { billingMembershipId: null } });
        }
        targetId = input.familyGroupId;
      }
      await createAuditLog({
        action: `fee-configuration.${parsed.data.action.toLowerCase()}`,
        memberId: guard.session.user.id,
        targetId,
        details: JSON.stringify(parsed.data),
      }, tx);
    });
    revalidatePath("/", "layout");
    return NextResponse.json(await loadConfiguration(true));
  } catch (error) {
    if (error instanceof FeeScheduleValidationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Failed to update fee configuration." }, { status: 500 });
  }
}
