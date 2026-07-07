import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  buildUniqueLodgeSlug,
  lodgeOrderBy,
  lodgeSelect,
  normalizeLodgeText,
  serializeLodge,
  syncSoleActiveLodgeIdentity,
} from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    doorCode: z.string().trim().max(80).nullable().optional(),
    travelNote: z.string().trim().max(2000).nullable().optional(),
    active: z.boolean().optional().default(true),
  })
  .strict();

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const lodges = await prisma.lodge.findMany({
    orderBy: lodgeOrderBy(),
    select: lodgeSelect,
  });

  return NextResponse.json({ lodges: lodges.map(serializeLodge) });
}

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
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

  const slug = await buildUniqueLodgeSlug(prisma, parsed.data.name);

  const created = await prisma.$transaction(async (tx) => {
    const lodge = await tx.lodge.create({
      data: {
        name: parsed.data.name.trim(),
        slug,
        active: parsed.data.active,
        doorCode: normalizeLodgeText(parsed.data.doorCode),
        travelNote: normalizeLodgeText(parsed.data.travelNote),
      },
      select: lodgeSelect,
    });

    await syncSoleActiveLodgeIdentity(tx);

    await tx.auditLog.create(
      buildStructuredAuditLogCreateArgs({
        action: "LODGE_CREATED",
        actor: { memberId: session.user.id },
        entity: { type: "Lodge", id: lodge.id },
        category: "admin",
        severity: "important",
        outcome: "success",
        summary: "Lodge created",
        metadata: { newLodge: serializeLodge(lodge) },
        request: getAuditRequestContext(request),
      }),
    );

    return lodge;
  });

  return NextResponse.json(
    { lodge: serializeLodge(created) },
    { status: 201 },
  );
}
