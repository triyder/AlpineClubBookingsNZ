import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  isReservedPageSlug,
  isSystemPageSlug,
  isValidPageSlug,
  normalizePageSlug,
  SYSTEM_PAGE_SLUGS,
  toPagePath,
} from "@/lib/page-content";
import {
  listEditablePageContent,
  sanitizePageContentHtml,
  sanitizeStructuredContent,
} from "@/lib/page-content-html";
import {
  getPageContentSchema,
  toStructuredContentValues,
} from "@/lib/page-content-schema";

const createSchema = z
  .object({
    caption: z.string().trim().max(120),
    menuTitle: z.string().trim().max(120),
    title: z.string().trim().min(1).max(120),
    headerText: z.string().max(20000),
    slug: z.string().trim().min(1).max(80),
    sortOrder: z.number().int().min(0).max(9999),
  })
  .strict();

// Structured content: a flat keyed object whose values are either a plain
// string or an array of string-keyed rows. Length caps bound abuse; markup is
// stripped from every string at save time.
const structuredRowSchema = z.record(z.string(), z.string().max(12000));
const structuredFieldSchema = z.union([
  z.string().max(12000),
  z.array(structuredRowSchema).max(50),
]);
const structuredContentSchema = z.record(z.string(), structuredFieldSchema);

const updateSchema = z
  .object({
    id: z.string().trim().min(1),
    caption: z.string().trim().max(120),
    menuTitle: z.string().trim().max(120),
    title: z.string().trim().min(1).max(120),
    headerText: z.string().max(20000),
    slug: z.string().trim().min(1).max(80),
    sortOrder: z.number().int().min(0).max(9999),
    contentHtml: z.string().max(200000),
    // Optional: only design pages send it. Absent => the column is left as-is.
    structuredContent: structuredContentSchema.optional(),
  })
  .strict();

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

const adminGuardOptions = {
  forbiddenResponse: unauthorizedResponse,
};

export async function GET() {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  const pages = await listEditablePageContent();
  return NextResponse.json({ pages });
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const slug = normalizePageSlug(parsed.data.slug);
  if (!isValidPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "Slug must use lowercase letters, numbers, and hyphens, with optional forward slashes between segments (for example: trip-reports or join/apply)",
      },
      { status: 400 },
    );
  }

  if (isReservedPageSlug(slug)) {
    return NextResponse.json(
      { error: "This slug is reserved and cannot be used" },
      { status: 400 },
    );
  }

  const path = toPagePath(slug);

  const safeHeaderText = sanitizePageContentHtml(parsed.data.headerText);

  const existing = await prisma.pageContent.findFirst({
    where: {
      OR: [{ slug }, { path }],
    },
    select: { id: true },
  });

  if (existing) {
    return NextResponse.json(
      { error: "A page with that slug already exists" },
      { status: 409 },
    );
  }

  const created = await prisma.pageContent.create({
    data: {
      slug,
      path,
      caption: parsed.data.caption,
      menuTitle: parsed.data.menuTitle,
      title: parsed.data.title,
      headerText: safeHeaderText,
      sortOrder: parsed.data.sortOrder,
      contentHtml: "",
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_CREATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: created.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page created for ${slug}`,
      metadata: {
        slug,
        path,
        caption: created.caption,
        menuTitle: created.menuTitle,
        title: created.title,
        headerText: created.headerText,
        sortOrder: created.sortOrder,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json(
    {
      page: {
        id: created.id,
        slug: created.slug,
        path: created.path,
        caption: created.caption,
        menuTitle: created.menuTitle,
        title: created.title,
        headerText: created.headerText,
        sortOrder: created.sortOrder,
        contentHtml: created.contentHtml,
        structuredContent: toStructuredContentValues(created.structuredContent),
        updatedAt: created.updatedAt.toISOString(),
        updatedByMemberId: created.updatedByMemberId,
      },
    },
    { status: 201 },
  );
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const slug = normalizePageSlug(parsed.data.slug);
  if (!isValidPageSlug(slug)) {
    return NextResponse.json(
      {
        error:
          "Slug must use lowercase letters, numbers, and hyphens, with optional forward slashes between segments (for example: trip-reports or join/apply)",
      },
      { status: 400 },
    );
  }

  if (isReservedPageSlug(slug)) {
    return NextResponse.json(
      { error: "This slug is reserved and cannot be used" },
      { status: 400 },
    );
  }

  const path = toPagePath(slug);

  const safeContentHtml = sanitizePageContentHtml(parsed.data.contentHtml);
  const safeHeaderText = sanitizePageContentHtml(parsed.data.headerText);
  // Strip markup from every string; undefined means "leave the column as-is".
  const safeStructuredContent =
    parsed.data.structuredContent === undefined
      ? undefined
      : sanitizeStructuredContent(parsed.data.structuredContent);

  const existing = await prisma.pageContent.findUnique({
    where: {
      id: parsed.data.id,
    },
  });

  if (!existing) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  // System pages have fixed slugs and fixed sort orders.
  if (isSystemPageSlug(existing.slug)) {
    if (slug !== existing.slug) {
      return NextResponse.json(
        { error: `The slug for this system page cannot be changed` },
        { status: 422 },
      );
    }
    const fixedOrder = SYSTEM_PAGE_SLUGS.get(existing.slug)!;
    if (parsed.data.sortOrder !== fixedOrder) {
      return NextResponse.json(
        {
          error: `Menu order for "${existing.slug}" is fixed at ${fixedOrder} and cannot be changed`,
        },
        { status: 422 },
      );
    }
  }

  const duplicate = await prisma.pageContent.findFirst({
    where: {
      id: { not: parsed.data.id },
      OR: [{ slug }, { path }],
    },
    select: { id: true },
  });

  if (duplicate) {
    return NextResponse.json(
      { error: "Another page already uses that slug" },
      { status: 409 },
    );
  }

  // Keys whose value changed, for the audit trail. Compared against the
  // previously stored structured content (null when the column was empty).
  const previousStructured = toStructuredContentValues(
    existing.structuredContent,
  );
  const changedStructuredKeys =
    safeStructuredContent === undefined
      ? []
      : Array.from(
          new Set([
            ...Object.keys(previousStructured),
            ...Object.keys(safeStructuredContent),
          ]),
        ).filter(
          (key) =>
            JSON.stringify(previousStructured[key]) !==
            JSON.stringify(safeStructuredContent[key]),
        );

  const updated = await prisma.pageContent.update({
    where: { id: parsed.data.id },
    data: {
      slug,
      path,
      caption: parsed.data.caption,
      menuTitle: parsed.data.menuTitle,
      title: parsed.data.title,
      headerText: safeHeaderText,
      sortOrder: parsed.data.sortOrder,
      contentHtml: safeContentHtml,
      structuredContent: safeStructuredContent,
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: updated.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page content updated for ${slug}`,
      metadata: {
        slug,
        path,
        caption: parsed.data.caption,
        menuTitle: parsed.data.menuTitle,
        title: parsed.data.title,
        headerText: safeHeaderText,
        sortOrder: parsed.data.sortOrder,
        previousLength: existing?.contentHtml.length ?? 0,
        nextLength: safeContentHtml.length,
        structuredKeysChanged: changedStructuredKeys,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({
    page: {
      id: updated.id,
      slug: updated.slug,
      path: updated.path,
      caption: updated.caption,
      menuTitle: updated.menuTitle,
      title: updated.title,
      headerText: updated.headerText,
      sortOrder: updated.sortOrder,
      contentHtml: updated.contentHtml,
      structuredContent: toStructuredContentValues(updated.structuredContent),
      updatedAt: updated.updatedAt.toISOString(),
      updatedByMemberId: updated.updatedByMemberId,
    },
  });
}

export async function DELETE(request: NextRequest) {
  const guard = await requireAdmin(adminGuardOptions);
  if (!guard.ok) {
    return guard.response;
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing page id" }, { status: 400 });
  }

  const existing = await prisma.pageContent.findUnique({ where: { id } });
  if (!existing) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  // System pages (home, 404) must always exist.
  if (isSystemPageSlug(existing.slug)) {
    return NextResponse.json(
      { error: "System pages cannot be deleted" },
      { status: 422 },
    );
  }

  // Built-in design pages (about, rules, faq, committee, contact, join, ...)
  // are backed by a locked-layout schema and a code route. Deleting their
  // content row would strip the editable copy while the route still renders, so
  // only admin-created content pages can be removed here.
  if (getPageContentSchema(existing.path)) {
    return NextResponse.json(
      { error: "This is a built-in design page and cannot be deleted" },
      { status: 422 },
    );
  }

  await prisma.pageContent.delete({ where: { id } });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_DELETED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: existing.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page deleted for ${existing.slug}`,
      metadata: {
        slug: existing.slug,
        path: existing.path,
        title: existing.title,
        sortOrder: existing.sortOrder,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ success: true });
}
