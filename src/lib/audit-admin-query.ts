import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  endOfDateOnlyForTimeZone,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";
import {
  buildAuditCategoryWhere,
  buildAuditMemberScopeWhere,
  isAuditTimelineCategory,
  type AuditMemberScope,
  type AuditTimelineCategory,
} from "@/lib/audit-query";

const adminAuditLogQuerySchema = z.object({
  eventType: z.string().max(160).optional(),
  action: z.string().max(160).optional(),
  category: z.string().optional().default("all"),
  memberId: z.string().optional(),
  memberScope: z
    .enum(["involves", "actor", "subject"])
    .optional()
    .default("involves"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  outcome: z.string().max(40).optional(),
  severity: z.string().max(40).optional(),
  entityType: z.string().max(80).optional(),
  q: z.string().max(160).optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

type AdminAuditLogFilters = {
  eventType: string;
  category: AuditTimelineCategory;
  memberId: string | null;
  memberScope: AuditMemberScope;
  from: string | null;
  to: string | null;
  outcome: string;
  severity: string;
  entityType: string;
  q: string | null;
};

type ParsedAdminAuditLogQuery = {
  page: number;
  pageSize: number;
  category: AuditTimelineCategory;
  eventType: string | undefined;
  where: Prisma.AuditLogWhereInput;
  filters: AdminAuditLogFilters;
};

export type AdminAuditLogQueryParseResult =
  | { success: true; data: ParsedAdminAuditLogQuery }
  | {
      success: false;
      details?: ReturnType<
        z.ZodError<z.infer<typeof adminAuditLogQuerySchema>>["flatten"]
      >;
    };

function getSearchParam(searchParams: URLSearchParams, name: string) {
  return searchParams.get(name) ?? undefined;
}

function optionalAuditFilter(value?: string): string | undefined {
  if (!value || value === "all") {
    return undefined;
  }
  return value;
}

function buildAuditDateWhere(params: {
  from?: string;
  to?: string;
}): Prisma.AuditLogWhereInput | null {
  if (!params.from && !params.to) {
    return null;
  }

  const createdAt: Prisma.DateTimeFilter = {};
  if (params.from) {
    createdAt.gte = startOfDateOnlyForTimeZone(params.from);
  }
  if (params.to) {
    createdAt.lte = endOfDateOnlyForTimeZone(params.to);
  }
  return { createdAt };
}

function buildAuditTextSearchWhere(
  q?: string,
): Prisma.AuditLogWhereInput | null {
  const search = q?.trim();
  if (!search) {
    return null;
  }

  return {
    OR: [
      { action: { contains: search, mode: "insensitive" } },
      { summary: { contains: search, mode: "insensitive" } },
      { details: { contains: search, mode: "insensitive" } },
      { requestId: { contains: search, mode: "insensitive" } },
      { entityId: { contains: search, mode: "insensitive" } },
      { targetId: { contains: search, mode: "insensitive" } },
    ],
  };
}

function buildGlobalAuditWhere(params: {
  eventType?: string;
  category: AuditTimelineCategory;
  memberId?: string;
  memberScope: AuditMemberScope;
  from?: string;
  to?: string;
  outcome?: string;
  severity?: string;
  entityType?: string;
  q?: string;
}): Prisma.AuditLogWhereInput {
  const clauses: Prisma.AuditLogWhereInput[] = [];

  if (params.eventType) {
    clauses.push({ action: params.eventType });
  }

  const categoryWhere = buildAuditCategoryWhere(params.category);
  if (categoryWhere) {
    clauses.push(categoryWhere);
  }

  if (params.memberId) {
    clauses.push(buildAuditMemberScopeWhere(params.memberId, params.memberScope));
  }

  const dateWhere = buildAuditDateWhere(params);
  if (dateWhere) {
    clauses.push(dateWhere);
  }

  if (params.outcome) {
    clauses.push({ outcome: params.outcome });
  }
  if (params.severity) {
    clauses.push({ severity: params.severity });
  }
  if (params.entityType) {
    clauses.push({ entityType: params.entityType });
  }

  const textSearchWhere = buildAuditTextSearchWhere(params.q);
  if (textSearchWhere) {
    clauses.push(textSearchWhere);
  }

  return clauses.length > 0 ? { AND: clauses } : {};
}

export function parseAdminAuditLogQuery(
  searchParams: URLSearchParams,
): AdminAuditLogQueryParseResult {
  const parsed = adminAuditLogQuerySchema.safeParse({
    eventType: getSearchParam(searchParams, "eventType"),
    action: getSearchParam(searchParams, "action"),
    category: getSearchParam(searchParams, "category"),
    memberId: getSearchParam(searchParams, "memberId"),
    memberScope: getSearchParam(searchParams, "memberScope"),
    from: getSearchParam(searchParams, "from"),
    to: getSearchParam(searchParams, "to"),
    outcome: getSearchParam(searchParams, "outcome"),
    severity: getSearchParam(searchParams, "severity"),
    entityType: getSearchParam(searchParams, "entityType"),
    q: getSearchParam(searchParams, "q"),
    page: getSearchParam(searchParams, "page"),
    pageSize: getSearchParam(searchParams, "pageSize"),
  });

  if (!parsed.success || !isAuditTimelineCategory(parsed.data.category)) {
    return {
      success: false,
      details: parsed.success ? undefined : parsed.error.flatten(),
    };
  }

  const category = parsed.data.category;
  const eventType = optionalAuditFilter(
    parsed.data.eventType ?? parsed.data.action,
  );
  const outcome = optionalAuditFilter(parsed.data.outcome);
  const severity = optionalAuditFilter(parsed.data.severity);
  const entityType = optionalAuditFilter(parsed.data.entityType);
  const memberId = optionalAuditFilter(parsed.data.memberId);
  const where = buildGlobalAuditWhere({
    eventType,
    category,
    memberId,
    memberScope: parsed.data.memberScope,
    from: parsed.data.from,
    to: parsed.data.to,
    outcome,
    severity,
    entityType,
    q: parsed.data.q,
  });

  return {
    success: true,
    data: {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      category,
      eventType,
      where,
      filters: {
        eventType: eventType ?? "all",
        category,
        memberId: memberId ?? null,
        memberScope: parsed.data.memberScope,
        from: parsed.data.from ?? null,
        to: parsed.data.to ?? null,
        outcome: outcome ?? "all",
        severity: severity ?? "all",
        entityType: entityType ?? "all",
        q: parsed.data.q?.trim() || null,
      },
    },
  };
}
