import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  canUnpublishPage,
  isReservedPageSlug,
  isSystemPageSlug,
  isValidPageSlug,
  normalizePageSlug,
  PAGE_CONTENT_LIMITS,
  SYSTEM_PAGE_SLUGS,
  toPagePath,
} from "@/lib/page-content";
import {
  listEditablePageContent,
  sanitizePageContentHtml,
} from "@/lib/page-content-html";
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation";

const createSchema = z
  .object({
    caption: z.string().trim().max(PAGE_CONTENT_LIMITS.captionMax),
    menuTitle: z.string().trim().max(PAGE_CONTENT_LIMITS.menuTitleMax),
    title: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.titleMax),
    headerText: z.string().max(PAGE_CONTENT_LIMITS.headerTextMax),
    slug: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.slugMax),
    sortOrder: z
      .number()
      .int()
      .min(PAGE_CONTENT_LIMITS.sortOrderMin)
      .max(PAGE_CONTENT_LIMITS.sortOrderMax),
  })
  .strict();

const updateSchema = z
  .object({
    id: z.string().trim().min(1),
    caption: z.string().trim().max(PAGE_CONTENT_LIMITS.captionMax),
    menuTitle: z.string().trim().max(PAGE_CONTENT_LIMITS.menuTitleMax),
    title: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.titleMax),
    headerText: z.string().max(PAGE_CONTENT_LIMITS.headerTextMax),
    slug: z.string().trim().min(1).max(PAGE_CONTENT_LIMITS.slugMax),
    sortOrder: z
      .number()
      .int()
      .min(PAGE_CONTENT_LIMITS.sortOrderMin)
      .max(PAGE_CONTENT_LIMITS.sortOrderMax),
    contentHtml: z.string().max(PAGE_CONTENT_LIMITS.contentHtmlMax),
  })
  .strict();

const patchSchema = z
  .object({
    id: z.string().trim().min(1),
    published: z.boolean(),
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

  revalidatePublicPageContent();
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
        published: created.published,
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
      },
      request: getAuditRequestContext(request),
    }),
  );

  revalidatePublicPageContent();
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
      published: updated.published,
      updatedAt: updated.updatedAt.toISOString(),
      updatedByMemberId: updated.updatedByMemberId,
    },
  });
}

// Toggles a page's public visibility (publish/unpublish). Only admin-created
// pages can be hidden; system and built-in pages must always stay published.
export async function PATCH(request: NextRequest) {
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

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.pageContent.findUnique({
    where: { id: parsed.data.id },
  });

  if (!existing) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  // System pages (home, 404) and built-in design pages are linked from code
  // routes, the footer, and the sitemap, so they cannot be hidden.
  if (!parsed.data.published && !canUnpublishPage(existing.slug)) {
    return NextResponse.json(
      { error: "This page cannot be hidden from the public site" },
      { status: 422 },
    );
  }

  const updated = await prisma.pageContent.update({
    where: { id: parsed.data.id },
    data: {
      published: parsed.data.published,
      updatedByMemberId: guard.session.user.id,
    },
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "PAGE_CONTENT_VISIBILITY_CHANGED",
      actor: { memberId: guard.session.user.id },
      entity: {
        type: "PageContent",
        id: updated.id,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: `Page ${updated.published ? "published" : "unpublished"} for ${existing.slug}`,
      metadata: {
        slug: existing.slug,
        path: existing.path,
        published: updated.published,
      },
      request: getAuditRequestContext(request),
    }),
  );

  revalidatePublicPageContent();
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
      published: updated.published,
      updatedAt: updated.updatedAt.toISOString(),
      updatedByMemberId: updated.updatedByMemberId,
    },
  });
}
