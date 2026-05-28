import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where = {
    deletedAt: null,
    ...(status === "ALL" ? { adminReviewStatus: { not: null } } : { adminReviewStatus: status }),
  } as const;

  const [bookings, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        adminReviewedBy: {
          select: { id: true, firstName: true, lastName: true },
        },
        guests: {
          select: { id: true, firstName: true, lastName: true, ageTier: true, isMember: true },
        },
      },
      orderBy: [{ adminReviewStatus: "asc" }, { createdAt: "desc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.booking.count({ where }),
  ]);

  return NextResponse.json({
    data: bookings,
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
}
