/**
 * F-COMP-04: Admin — List Deletion Requests
 * GET /api/admin/deletion-requests
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { z } from "zod";

const querySchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "ALL"]).optional().default("PENDING"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(searchParams));

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;

  try {
    const where =
      status === "ALL"
        ? {}
        : { status };

    const [requests, total] = await Promise.all([
      prisma.deletionRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          member: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              role: true,
              active: true,
            },
          },
        },
      }),
      prisma.deletionRequest.count({ where }),
    ]);

    const data = requests.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      adminNote: r.adminNote,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt,
      createdAt: r.createdAt,
      member: r.member,
    }));

    return NextResponse.json({
      data,
      requests: data,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (err) {
    logger.error({ err }, "Failed to list deletion requests");
    return NextResponse.json({ error: "Failed to load deletion requests" }, { status: 500 });
  }
}
