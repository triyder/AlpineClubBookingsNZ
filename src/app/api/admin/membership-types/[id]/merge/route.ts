import { NextResponse } from "next/server";
import type { AgeTier, Prisma } from "@prisma/client";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { serializeMembershipType } from "@/lib/membership-types";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

// Same shape the collection/[id] routes use so serializeMembershipType and the
// merge guards see age tiers, Xero rules, and the current assignment count.
const membershipTypeSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  isActive: true,
  isBuiltIn: true,
  bookingBehavior: true,
  subscriptionBehavior: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  allowedAgeTiers: {
    select: { ageTier: true },
    orderBy: { ageTier: "asc" },
  },
  xeroContactGroupRules: {
    select: {
      id: true,
      ageTier: true,
      mode: true,
      groupId: true,
      groupName: true,
      isActive: true,
      sortOrder: true,
    },
    orderBy: [{ sortOrder: "asc" }, { groupName: "asc" }, { groupId: "asc" }],
  },
  _count: { select: { assignments: true } },
} satisfies Prisma.MembershipTypeSelect;

const paramsSchema = z.object({
  id: z.string().min(1),
});

const mergeSchema = z
  .object({
    targetId: z.string().trim().min(1),
  })
  .strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

  const parsedParams = paramsSchema.safeParse(await params);
  if (!parsedParams.success) {
    return NextResponse.json(
      {
        error: "Invalid route parameters",
        details: parsedParams.error.flatten(),
      },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = mergeSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const sourceId = parsedParams.data.id;
  const targetId = parsed.data.targetId;

  // A type can never be merged into itself: it would delete the type we are
  // reassigning onto and orphan every assignment.
  if (sourceId === targetId) {
    return NextResponse.json(
      { error: "A membership type cannot be merged into itself." },
      { status: 400 },
    );
  }

  const [source, target] = await Promise.all([
    prisma.membershipType.findUnique({
      where: { id: sourceId },
      select: membershipTypeSelect,
    }),
    prisma.membershipType.findUnique({
      where: { id: targetId },
      select: membershipTypeSelect,
    }),
  ]);

  if (!source) {
    return NextResponse.json(
      { error: "Source membership type not found" },
      { status: 404 },
    );
  }

  // Mirror the DELETE guard: built-in types are structural and can never be
  // deleted, so they can never be a merge source (the merge deletes the source).
  if (source.isBuiltIn) {
    return NextResponse.json(
      { error: "Built-in membership types cannot be merged or deleted" },
      { status: 409 },
    );
  }

  if (!target) {
    return NextResponse.json(
      { error: "Target membership type not found" },
      { status: 404 },
    );
  }

  // Reassigning onto an archived type would silently move members onto a type
  // that is no longer assignable, so require an active target (isActive === false
  // is the archived state in this schema).
  if (!target.isActive) {
    return NextResponse.json(
      {
        error:
          "Archived membership types cannot be a merge target. Reactivate the target type first.",
      },
      { status: 409 },
    );
  }

  // Age-tier compatibility: every affected member's current age tier must be
  // allowed by the target type. NOT_APPLICABLE (organisations) is exempt — it is
  // never a configurable allowed tier and orgs are excluded from every
  // age-based rule (see docs/DOMAIN_INVARIANTS.md).
  const sourceAssignments = await prisma.seasonalMembershipAssignment.findMany({
    where: { membershipTypeId: sourceId },
    select: {
      id: true,
      memberId: true,
      seasonYear: true,
      member: { select: { ageTier: true } },
    },
  });

  const targetAllowedAgeTiers = new Set<AgeTier>(
    target.allowedAgeTiers.map((tier) => tier.ageTier),
  );
  const offendingAgeTiers = new Set<AgeTier>();
  for (const assignment of sourceAssignments) {
    const ageTier = assignment.member.ageTier;
    if (ageTier === "NOT_APPLICABLE") {
      continue;
    }
    if (!targetAllowedAgeTiers.has(ageTier)) {
      offendingAgeTiers.add(ageTier);
    }
  }
  if (offendingAgeTiers.size > 0) {
    const offending = [...offendingAgeTiers].join(", ");
    return NextResponse.json(
      {
        error: `Target type "${target.name}" does not allow age tier(s) ${offending} held by affected members. Add the tier(s) to the target's allowed age tiers or reassign those members before merging.`,
      },
      { status: 409 },
    );
  }

  // Pending roll-forward guard: N/A. Roll-forward runs synchronously inside a
  // single transaction (see rollForwardSeasonalMembershipAssignments) and never
  // persists a "pending" record that a delete could corrupt. Reassigning
  // already-created assignments onto the target keeps every rolled-forward row
  // intact, so there is no pending state to block on.

  // Snapshot of exactly which assignments/members are being moved, so the merge
  // is traceable and reversible. reassignedCount (below) stays the authoritative
  // total; this list is capped to keep the audit metadata bounded.
  const REASSIGNED_AUDIT_SAMPLE_LIMIT = 500;
  const reassignedAssignments = sourceAssignments
    .slice(0, REASSIGNED_AUDIT_SAMPLE_LIMIT)
    .map((assignment) => ({
      assignmentId: assignment.id,
      memberId: assignment.memberId,
      seasonYear: assignment.seasonYear,
    }));

  const reassignedCount = await prisma.$transaction(async (tx) => {
    const reassigned = await tx.seasonalMembershipAssignment.updateMany({
      where: { membershipTypeId: sourceId },
      data: { membershipTypeId: targetId },
    });

    // Audit the reassignment + deletion as one MEMBERSHIP_TYPE_MERGED record.
    // Xero coherence note: assignment-type changes in this app are NOT
    // synchronously resynced to Xero contact groups (see
    // saveSeasonalMembershipAssignment / the seasonal-membership route, which
    // only upsert + audit). Reconciliation is by the existing periodic /
    // admin mismatch tooling (resyncXeroContactCachesByIds and the contact-group
    // mismatch panels), so this route deliberately does not enqueue a Xero
    // resync. The UI surfaces a Xero-rule-diff warning before confirm instead.
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_MERGED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: sourceId },
        category: "admin",
        severity: "critical",
        outcome: "success",
        summary: "Membership type merged and deleted",
        metadata: {
          sourceId,
          sourceKey: source.key,
          sourceName: source.name,
          targetId,
          targetKey: target.key,
          targetName: target.name,
          reassignedCount: reassigned.count,
          reassignedAssignments,
          reassignedAssignmentsTruncated:
            sourceAssignments.length > reassignedAssignments.length,
          sourceXeroContactGroupRules: source.xeroContactGroupRules,
          targetXeroContactGroupRules: target.xeroContactGroupRules,
          xeroReconciliation: "periodic",
        },
        request: getAuditRequestContext(request),
      }),
    );

    // Source now has zero assignments, so the DELETE constraint (no seasonal
    // assignments) is satisfied — reuse the exact delete semantics.
    await tx.membershipType.delete({ where: { id: sourceId } });
    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "MEMBERSHIP_TYPE_DELETED",
        actor: { memberId: session.user.id },
        entity: { type: "MembershipType", id: sourceId },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Membership type deleted via merge",
        metadata: {
          previousMembershipType: serializeMembershipType(source),
          mergedIntoId: targetId,
          mergedIntoName: target.name,
        },
        request: getAuditRequestContext(request),
      }),
    );

    return reassigned.count;
  });

  return NextResponse.json({
    ok: true,
    reassignedCount,
    sourceId,
    targetId,
  });
}
