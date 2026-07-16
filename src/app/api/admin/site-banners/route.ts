import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";
import {
  SITE_BANNER_MESSAGE_MAX_LENGTH,
  SITE_BANNER_PRIORITIES,
} from "@/lib/site-banner-shared";
import {
  listSiteBannersForAdmin,
  serializeAdminSiteBanner,
  siteBannerAuditSnapshot,
} from "@/lib/site-banners";
import {
  invalidatePublicLayoutConfig,
  PUBLIC_LAYOUT_CACHE_TAGS,
} from "@/lib/public-layout-cache";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const createSchema = z
  .object({
    message: z.string().trim().min(1).max(SITE_BANNER_MESSAGE_MAX_LENGTH),
    priority: z.enum(SITE_BANNER_PRIORITIES),
    startDate: dateOnlyString,
    endDate: dateOnlyString,
    active: z.boolean().optional().default(true),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json(await listSiteBannersForAdmin());
}

export async function POST(request: Request) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }
  const session = guard.session;

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

  const { message, priority, startDate, endDate, active } = parsed.data;
  const parsedStartDate = parseDateOnly(startDate);
  const parsedEndDate = parseDateOnly(endDate);

  // Single-day banners (startDate === endDate) are allowed; the window is
  // inclusive on both ends in NZ date-only terms.
  if (parsedEndDate < parsedStartDate) {
    return NextResponse.json(
      { error: "End date must be on or after the start date" },
      { status: 400 },
    );
  }

  // Create the banner and its audit record atomically.
  const banner = await prisma.$transaction(async (tx) => {
    const created = await tx.siteBanner.create({
      data: {
        message,
        priority,
        startDate: parsedStartDate,
        endDate: parsedEndDate,
        active,
        createdByMemberId: session.user.id,
        updatedByMemberId: session.user.id,
      },
    });

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "SITE_BANNER_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "SiteBanner", id: created.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Site banner created",
        metadata: {
          banner: siteBannerAuditSnapshot(created),
        },
        request: getAuditRequestContext(request),
      }),
    );

    return created;
  });

  invalidatePublicLayoutConfig(PUBLIC_LAYOUT_CACHE_TAGS.banners);

  return NextResponse.json(
    { banner: serializeAdminSiteBanner(banner) },
    { status: 201 },
  );
}
