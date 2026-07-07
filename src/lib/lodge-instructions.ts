import "server-only";

import { prisma } from "@/lib/prisma";
import { getTodayDateOnly } from "@/lib/date-only";
import { sanitizePageContentHtml } from "@/lib/page-content-html";
import { resolveTextTokens } from "@/lib/page-content-embeds";
import { hasAdminAccess, type AccessRoleInput } from "@/lib/access-roles";

// Canonical display order for the three keyed documents.
export const LODGE_INSTRUCTION_KEYS = ["OPEN", "CLOSE", "DAY_TO_DAY"] as const;

type LodgeInstructionKeyValue = (typeof LODGE_INSTRUCTION_KEYS)[number];

const LODGE_INSTRUCTION_LABELS: Record<
  LodgeInstructionKeyValue,
  { title: string; description: string }
> = {
  OPEN: {
    title: "Opening the Lodge",
    description: "Steps to open the lodge at the start of a stay or season.",
  },
  CLOSE: {
    title: "Closing the Lodge",
    description: "Steps to shut the lodge down safely before leaving.",
  },
  DAY_TO_DAY: {
    title: "Day-to-Day Running",
    description: "Daily routines and duties while the lodge is occupied.",
  },
};

export type LodgeInstructionDocument = {
  key: LodgeInstructionKeyValue;
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

/**
 * A member qualifies as a lodge-instructions reader while they hold a
 * current or upcoming hut leader assignment (endDate on or after today,
 * NZ date-only semantics). Expired assignments do not qualify.
 */
async function hasCurrentOrUpcomingHutLeaderAssignment(
  memberId: string,
): Promise<boolean> {
  const today = getTodayDateOnly();
  const count = await prisma.hutLeaderAssignment.count({
    where: {
      memberId,
      endDate: { gte: today },
    },
  });
  return count > 0;
}

/**
 * Reader access rule for the lodge instructions: admins always qualify;
 * members qualify with a current or upcoming hut leader assignment.
 * (The lodge kiosk surface uses the kiosk auth path instead.)
 */
export async function canReadLodgeInstructions(
  memberId: string,
  subject: AccessRoleInput,
): Promise<boolean> {
  if (hasAdminAccess(subject)) {
    return true;
  }
  return hasCurrentOrUpcomingHutLeaderAssignment(memberId);
}

/**
 * Returns all three documents in canonical order. Stored values are
 * sanitised on write, but every render path injects contentHtml with
 * dangerouslySetInnerHTML, so sanitise again on read (defence in depth,
 * matching getSanitizedPageContentByPath).
 *
 * When `resolveTokens` is set, text tokens such as {{club-name}} are
 * replaced after sanitising; resolveTextTokens HTML-escapes every
 * replacement value, so resolution cannot reintroduce unsafe markup.
 * Reader/kiosk routes resolve tokens; the admin editor route must not,
 * so editors round-trip the literal {{token}} text.
 */
export async function getSanitizedLodgeInstructions(options?: {
  resolveTokens?: boolean;
}): Promise<LodgeInstructionDocument[]> {
  const records = await prisma.lodgeInstruction.findMany({
    select: {
      key: true,
      contentHtml: true,
      updatedAt: true,
    },
  });

  const byKey = new Map(records.map((record) => [record.key, record]));

  return Promise.all(
    LODGE_INSTRUCTION_KEYS.map(async (key) => {
      const record = byKey.get(key);
      let contentHtml = record
        ? sanitizePageContentHtml(record.contentHtml)
        : "";
      if (options?.resolveTokens && contentHtml) {
        contentHtml = await resolveTextTokens(contentHtml);
      }
      return {
        key,
        title: LODGE_INSTRUCTION_LABELS[key].title,
        description: LODGE_INSTRUCTION_LABELS[key].description,
        contentHtml,
        updatedAt: record ? record.updatedAt.toISOString() : null,
      };
    }),
  );
}
