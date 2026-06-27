import { prisma } from "@/lib/prisma";

export const LODGE_SETTINGS_ID = "default";

type LodgeCapacityReader = {
  lodgeSettings?: {
    findUnique: (args: {
      where: { id: string };
    }) => Promise<{ capacity: number | null } | null>;
  };
};

/**
 * Admin-set lodge capacity override, or null to fall back to the club config
 * bed total. Reads are resilient: a missing delegate or a query failure resolves
 * to null so capacity always falls back rather than throwing.
 */
export async function loadLodgeCapacityOverride(
  db: LodgeCapacityReader = prisma,
): Promise<number | null> {
  if (!db.lodgeSettings?.findUnique) return null;

  try {
    const record = await db.lodgeSettings.findUnique({
      where: { id: LODGE_SETTINGS_ID },
    });
    return record?.capacity ?? null;
  } catch {
    return null;
  }
}

export async function updateLodgeCapacity(input: {
  capacity: number | null;
  updatedByMemberId: string;
}): Promise<{ capacity: number | null; updatedAt: Date }> {
  return prisma.lodgeSettings.upsert({
    where: { id: LODGE_SETTINGS_ID },
    create: {
      id: LODGE_SETTINGS_ID,
      capacity: input.capacity,
      updatedByMemberId: input.updatedByMemberId,
    },
    update: {
      capacity: input.capacity,
      updatedByMemberId: input.updatedByMemberId,
    },
    select: { capacity: true, updatedAt: true },
  });
}
