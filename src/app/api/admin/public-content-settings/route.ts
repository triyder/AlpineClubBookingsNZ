import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { z } from "zod";
import { buildStructuredAuditLogCreateArgs, getAuditRequestContext } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const settingsSchema = z.object({
  membershipTypes: z.boolean(),
  entranceFees: z.boolean(),
  hutFees: z.boolean(),
  bookingPolicySummary: z.boolean(),
  cancellationPolicy: z.boolean(),
  // Dedicated {{annual-fees}} double-opt-in gate (#1933, E7).
  annualFees: z.boolean(),
  // Configurable public Book Now button (E3 #1929).
  showBookNow: z.boolean(),
  bookNowTarget: z.enum(["BOOKING_FLOW", "PAGE"]),
  bookNowPageId: z.string().min(1).nullable(),
  // Committee-roster photo display + shape (MP5, #171).
  committeePhotoDisplay: z.enum(["NONE", "CIRCLE", "SQUARE"]),
}).strict();

type Settings = {
  membershipTypes: boolean;
  entranceFees: boolean;
  hutFees: boolean;
  bookingPolicySummary: boolean;
  cancellationPolicy: boolean;
  annualFees: boolean;
  showBookNow: boolean;
  bookNowTarget: "BOOKING_FLOW" | "PAGE";
  bookNowPageId: string | null;
  committeePhotoDisplay: "NONE" | "CIRCLE" | "SQUARE";
};

const defaults: Settings = {
  membershipTypes: false,
  entranceFees: false,
  hutFees: false,
  bookingPolicySummary: false,
  cancellationPolicy: false,
  annualFees: false,
  showBookNow: true,
  bookNowTarget: "BOOKING_FLOW",
  bookNowPageId: null,
  committeePhotoDisplay: "NONE",
};

const settingsSelect = {
  membershipTypes: true,
  entranceFees: true,
  hutFees: true,
  bookingPolicySummary: true,
  cancellationPolicy: true,
  annualFees: true,
  showBookNow: true,
  bookNowTarget: true,
  bookNowPageId: true,
  committeePhotoDisplay: true,
} as const;

function serializeSettings(row: Settings): Settings {
  return {
    membershipTypes: row.membershipTypes,
    entranceFees: row.entranceFees,
    hutFees: row.hutFees,
    bookingPolicySummary: row.bookingPolicySummary,
    cancellationPolicy: row.cancellationPolicy,
    annualFees: row.annualFees,
    showBookNow: row.showBookNow,
    bookNowTarget: row.bookNowTarget,
    bookNowPageId: row.bookNowPageId,
    committeePhotoDisplay: row.committeePhotoDisplay,
  };
}

// Published pages offered as Book Now targets in the admin select.
async function loadPublishedPages() {
  const pages = await prisma.pageContent.findMany({
    where: { published: true },
    select: { id: true, title: true, path: true },
    orderBy: { sortOrder: "asc" },
  });
  return pages;
}

export async function GET() {
  const guard = await requireAdmin({ permission: { area: "content", level: "view" } });
  if (!guard.ok) return guard.response;
  const [settings, pages] = await Promise.all([
    prisma.publicContentSettings.findUnique({ where: { id: "default" }, select: settingsSelect }),
    loadPublishedPages(),
  ]);
  return NextResponse.json({ settings: settings ? serializeSettings(settings) : defaults, pages });
}

export async function PUT(request: Request) {
  const guard = await requireAdmin({ permission: { area: "content", level: "edit" } });
  if (!guard.ok) return guard.response;
  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid settings" }, { status: 400 });

  // Book Now integrity: a PAGE target must name a published page. (Runtime also
  // fails open, but reject at write time so the admin gets clear feedback.)
  if (parsed.data.bookNowTarget === "PAGE") {
    if (!parsed.data.bookNowPageId) {
      return NextResponse.json({ error: "Select a published page for the Book Now target." }, { status: 400 });
    }
    const page = await prisma.pageContent.findUnique({
      where: { id: parsed.data.bookNowPageId },
      select: { published: true },
    });
    if (!page?.published) {
      return NextResponse.json({ error: "The selected Book Now page is not published." }, { status: 400 });
    }
  }
  // Never persist a stray page id when the target is the booking flow.
  const bookNowPageId = parsed.data.bookNowTarget === "PAGE" ? parsed.data.bookNowPageId : null;
  const writeData = { ...parsed.data, bookNowPageId };

  const settings = await prisma.$transaction(async (tx) => {
    const before = await tx.publicContentSettings.findUnique({ where: { id: "default" }, select: settingsSelect });
    const saved = await tx.publicContentSettings.upsert({
      where: { id: "default" },
      update: { ...writeData, updatedByMemberId: guard.session.user.id },
      create: { id: "default", ...writeData, updatedByMemberId: guard.session.user.id },
      select: settingsSelect,
    });
    await tx.auditLog.create(buildStructuredAuditLogCreateArgs({
      action: "PUBLIC_CONTENT_SETTINGS_UPDATED",
      actor: { memberId: guard.session.user.id },
      entity: { type: "PublicContentSettings", id: "default" },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Public fee and policy content visibility updated",
      metadata: { before: before ? serializeSettings(before) : defaults, after: writeData },
      request: getAuditRequestContext(request),
    }));
    return saved;
  });
  revalidatePath("/", "layout");
  return NextResponse.json({ settings: serializeSettings(settings) });
}
