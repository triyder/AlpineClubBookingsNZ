import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, type AgeTier } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { getXeroContactGroups, getXeroContactGroupCacheLastRefreshedAt } from "@/lib/xero";
import { isXeroConnected } from "@/lib/xero-token-store";
import { getXeroGroupingMode } from "@/lib/xero-member-grouping";
import {
  getXeroMemberGroupingSnapshot,
  runXeroMemberGroupingBulkResyncChunk,
} from "@/lib/xero-member-grouping-resync";

function requireFinanceEdit(
  session: { user: Parameters<typeof hasAdminAreaAccess>[0] },
): boolean {
  return hasAdminAreaAccess(session.user, {
    area: "finance",
    level: "edit",
  });
}

const forbidden = () =>
  NextResponse.json(
    { error: "Your admin role can view Xero member grouping but cannot make changes." },
    { status: 403 },
  );

const ruleModeEnum = z.enum(["MANAGED", "ACCEPTED"]);
const groupingModeEnum = z.enum(["NONE", "MEMBERSHIP_TYPE", "MEMBERSHIP_TYPE_AND_AGE"]);

const ruleShape = {
  membershipTypeId: z.string().trim().min(1).nullable().optional(),
  ageTier: ageTierEnum.nullable().optional(),
  mode: ruleModeEnum,
  groupId: z.string().trim().min(1).max(100),
  groupName: z.string().trim().min(1).max(255).nullable().optional(),
};

const postSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set-mode"), mode: groupingModeEnum }),
  z.object({ action: z.literal("create-rule"), ...ruleShape }),
  z.object({
    action: z.literal("update-rule"),
    id: z.string().min(1),
    ...ruleShape,
    isActive: z.boolean().optional(),
  }),
  z.object({ action: z.literal("delete-rule"), id: z.string().min(1) }),
  z.object({ action: z.literal("toggle-rule"), id: z.string().min(1), isActive: z.boolean() }),
  z.object({ action: z.literal("dry-run"), limit: z.number().int().min(1).max(1000).optional() }),
  z.object({
    action: z.literal("bulk-resync"),
    // Ships code-only this wave: the run cannot fire unless the admin has seen
    // the dry-run and explicitly confirms it.
    confirmDryRunReviewed: z.literal(true),
    // Capped low: each mismatched member costs ~4 Xero calls, so 100 members
    // is already ~400 calls of the ~5k/day budget in one request.
    limit: z.number().int().min(1).max(100).optional(),
    afterMemberId: z.string().min(1).optional(),
  }),
]);

async function loadConfig() {
  const [mode, rules, groups, lastRefreshedAt, membershipTypes] = await Promise.all([
    getXeroGroupingMode(),
    prisma.xeroContactGroupRule.findMany({
      orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        membershipTypeId: true,
        ageTier: true,
        mode: true,
        groupId: true,
        groupName: true,
        isActive: true,
        sortOrder: true,
        membershipType: { select: { name: true } },
      },
    }),
    getXeroContactGroups().catch(() => []),
    getXeroContactGroupCacheLastRefreshedAt().catch(() => null),
    prisma.membershipType.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  const ageTiers: AgeTier[] = ["INFANT", "CHILD", "YOUTH", "ADULT", "NOT_APPLICABLE"];

  return {
    mode,
    rules: rules.map((rule) => ({
      id: rule.id,
      membershipTypeId: rule.membershipTypeId,
      membershipTypeName: rule.membershipType?.name ?? null,
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId,
      groupName: rule.groupName,
      isActive: rule.isActive,
      sortOrder: rule.sortOrder,
    })),
    groups,
    lastRefreshedAt,
    membershipTypes,
    ageTiers,
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;
  return NextResponse.json(await loadConfig());
}

type RuleFields = {
  membershipTypeId?: string | null;
  ageTier?: AgeTier | null;
  mode: "MANAGED" | "ACCEPTED";
  groupId: string;
  groupName?: string | null;
};

function normalizeRule(input: RuleFields) {
  return {
    membershipTypeId: input.membershipTypeId?.trim() || null,
    ageTier: input.ageTier ?? null,
    mode: input.mode,
    groupId: input.groupId.trim(),
    groupName: input.groupName?.trim() || null,
  };
}

/** App-side dedupe for a friendly message before the DB partial unique index. */
async function isDuplicateRuleShape(
  rule: { membershipTypeId: string | null; ageTier: AgeTier | null; mode: "MANAGED" | "ACCEPTED"; groupId: string },
  excludeId?: string,
): Promise<boolean> {
  const existing = await prisma.xeroContactGroupRule.findFirst({
    where: {
      membershipTypeId: rule.membershipTypeId,
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
  return Boolean(existing);
}

const duplicateResponse = () =>
  NextResponse.json(
    { error: "A rule with the same membership type, age tier, mode, and Xero group already exists." },
    { status: 409 },
  );

export async function POST(request: NextRequest) {
  // Explicit finance:view guard — the path-inference default would map ANY
  // POST under /api/admin/xero to finance:edit, which made the dry-run's
  // view-level exception below unreachable (#1934 review). Mutating actions
  // are individually re-checked against finance:edit after parsing.
  const guard = await requireAdmin({
    permission: { area: "finance", level: "view" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  const body = await request.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // The dry-run is read-only; everything else requires finance:edit.
  if (data.action !== "dry-run" && !requireFinanceEdit(session)) {
    return forbidden();
  }

  try {
    switch (data.action) {
      case "set-mode": {
        await prisma.xeroGroupingSettings.upsert({
          where: { id: "default" },
          update: { mode: data.mode, updatedByMemberId: session.user.id },
          create: { id: "default", mode: data.mode, updatedByMemberId: session.user.id },
        });
        await logAudit({
          action: "XERO_GROUPING_MODE_UPDATED",
          memberId: session.user.id,
          details: JSON.stringify({ mode: data.mode }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "create-rule": {
        const rule = normalizeRule(data);
        if (await isDuplicateRuleShape(rule)) return duplicateResponse();
        const created = await prisma.xeroContactGroupRule.create({ data: rule });
        await logAudit({
          action: "XERO_GROUPING_RULE_CREATED",
          memberId: session.user.id,
          details: JSON.stringify({ id: created.id, ...rule }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "update-rule": {
        const rule = normalizeRule(data);
        if (await isDuplicateRuleShape(rule, data.id)) return duplicateResponse();
        await prisma.xeroContactGroupRule.update({
          where: { id: data.id },
          data: { ...rule, ...(data.isActive !== undefined ? { isActive: data.isActive } : {}) },
        });
        await logAudit({
          action: "XERO_GROUPING_RULE_UPDATED",
          memberId: session.user.id,
          details: JSON.stringify({ id: data.id, ...rule }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "toggle-rule": {
        await prisma.xeroContactGroupRule.update({
          where: { id: data.id },
          data: { isActive: data.isActive },
        });
        await logAudit({
          action: "XERO_GROUPING_RULE_TOGGLED",
          memberId: session.user.id,
          details: JSON.stringify({ id: data.id, isActive: data.isActive }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "delete-rule": {
        await prisma.xeroContactGroupRule.delete({ where: { id: data.id } });
        await logAudit({
          action: "XERO_GROUPING_RULE_DELETED",
          memberId: session.user.id,
          details: JSON.stringify({ id: data.id }),
        });
        return NextResponse.json(await loadConfig());
      }

      case "dry-run": {
        const snapshot = await getXeroMemberGroupingSnapshot({ limit: data.limit ?? 500 });
        return NextResponse.json({ snapshot });
      }

      case "bulk-resync": {
        // Admin-triggered, dry-run-gated. Ships as code + runbook this wave.
        // The chunk itself is a no-op under NONE mode, but the per-member sync
        // does NOT check Xero connectivity — without a connection every member
        // would fail individually — so pre-check here and fail cleanly.
        if (!(await isXeroConnected())) {
          return NextResponse.json(
            { error: "Xero is not connected. Connect Xero before running a bulk re-sync." },
            { status: 409 },
          );
        }
        const result = await runXeroMemberGroupingBulkResyncChunk({
          limit: data.limit,
          afterMemberId: data.afterMemberId,
          createdByMemberId: session.user.id,
        });
        await logAudit({
          action: "XERO_GROUPING_BULK_RESYNC",
          memberId: session.user.id,
          details: JSON.stringify({
            processed: result.processed,
            added: result.added,
            removed: result.removed,
            failed: result.failed,
            done: result.done,
            haltedByDailyLimit: result.haltedByDailyLimit,
            nextCursorMemberId: result.nextCursorMemberId,
            afterMemberId: data.afterMemberId ?? null,
          }),
        });
        return NextResponse.json({ result });
      }
    }
  } catch (error) {
    // The DB partial unique index (XeroContactGroupRule_shape_unique) is the
    // last line of defence for concurrent duplicate creates.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return duplicateResponse();
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json({ error: "Rule not found." }, { status: 404 });
    }
    throw error;
  }
}
