import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { parseJsonRequestBody } from "@/lib/api-json";
import { createAuditLog } from "@/lib/audit";
import { isPrismaUniqueConstraintError } from "@/lib/prisma-errors";

const createLockerSchema = z.object({
  name: z
    .string()
    .trim()
    .transform((value) => value.replace(/\s+/g, " "))
    .pipe(z.string().min(1).max(200)),
  allocatedToMemberId: z.string().trim().min(1).max(191).nullable().optional(),
});

async function findDuplicateLockerName(name: string) {
  return prisma.locker.findFirst({
    where: {
      name: {
        equals: name,
        mode: "insensitive",
      },
    },
    select: { id: true },
  });
}

/**
 * GET /api/admin/lockers
 * Returns lockers and active members for allocation dropdown.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const [lockers, members] = await Promise.all([
    prisma.locker.findMany({
      include: {
        allocatedTo: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
      orderBy: { name: "asc" },
    }),
    prisma.member.findMany({
      where: { active: true },
      select: { id: true, firstName: true, lastName: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
  ]);

  return NextResponse.json({ lockers, members });
}

/**
 * POST /api/admin/lockers
 * Creates a new locker, optionally allocated to a member.
 */
export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return guard.response;
  }

  const json = await parseJsonRequestBody(request);
  if (!json.ok) return json.response;

  const parsed = createLockerSchema.safeParse(json.body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const allocatedToMemberId = parsed.data.allocatedToMemberId ?? null;
  if (allocatedToMemberId) {
    const member = await prisma.member.findFirst({
      where: { id: allocatedToMemberId, active: true },
      select: { id: true },
    });
    if (!member) {
      return NextResponse.json(
        { error: "Allocated member not found" },
        { status: 404 },
      );
    }
  }

  if (await findDuplicateLockerName(parsed.data.name)) {
    return NextResponse.json(
      { error: "A locker with that name already exists" },
      { status: 409 },
    );
  }

  try {
    const locker = await prisma.$transaction(async (tx) => {
      const created = await tx.locker.create({
        data: {
          name: parsed.data.name,
          allocatedToMemberId,
        },
        include: {
          allocatedTo: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
      });

      await createAuditLog(
        {
          action: "locker.created",
          memberId: guard.session.user.id,
          entityType: "Locker",
          entityId: created.id,
          category: "admin",
          outcome: "success",
          summary: "Locker created",
          metadata: {
            lockerId: created.id,
            name: created.name,
            allocatedToMemberId,
          },
        },
        tx,
      );

      return created;
    });

    return NextResponse.json({ locker }, { status: 201 });
  } catch (error) {
    if (
      isPrismaUniqueConstraintError(error) ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002")
    ) {
      return NextResponse.json(
        { error: "A locker with that name already exists" },
        { status: 409 },
      );
    }

    return NextResponse.json(
      { error: "Failed to create locker" },
      { status: 500 },
    );
  }
}
