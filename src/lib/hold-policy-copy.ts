import { prisma } from "@/lib/prisma";

// Public pages that describe the non-member hold ("Members First") behaviour.
export const HOLD_COPY_SLUGS = ["terms", "faq"] as const;
export type HoldCopySlug = (typeof HOLD_COPY_SLUGS)[number];

const HOLD_COPY_TITLES: Record<HoldCopySlug, string> = {
  terms: "Terms of Service",
  faq: "FAQ",
};

export function holdCopyTitle(slug: HoldCopySlug): string {
  return HOLD_COPY_TITLES[slug];
}

/**
 * Decide whether a public page's hold copy predates the Members First / First
 * Paid, First In toggle (#1287).
 *
 * A page is "stale" when it still describes the non-member hold / bumping
 * behaviour but never mentions the "First Paid, First In" option the toggle
 * introduced. The toggle migration only refreshed copy that exactly matched the
 * old starter default, so any club that had customised its Terms/FAQ keeps the
 * pre-toggle wording — this is what the admin nudge flags for a manual refresh.
 */
export function isHoldCopyStale(contentHtml: string | null | undefined): boolean {
  if (!contentHtml) return false;
  const lower = contentHtml.toLowerCase();
  const describesHold =
    lower.includes("non-member") &&
    (lower.includes("pending") ||
      lower.includes("priority") ||
      lower.includes("bumped"));
  const mentionsFirstPaid = lower.includes("first paid, first in");
  return describesHold && !mentionsFirstPaid;
}

/**
 * Return the hold-copy pages whose live content predates the toggle, so the
 * Booking Policies admin can nudge the operator to refresh them. Never throws
 * on missing pages — an absent page simply isn't stale.
 */
export async function detectStaleHoldPolicyCopy(): Promise<HoldCopySlug[]> {
  const pages = await prisma.pageContent.findMany({
    where: { slug: { in: [...HOLD_COPY_SLUGS] } },
    select: { slug: true, contentHtml: true },
  });
  return pages
    .filter((page) => isHoldCopyStale(page.contentHtml))
    .map((page) => page.slug as HoldCopySlug)
    .sort((a, b) => HOLD_COPY_SLUGS.indexOf(a) - HOLD_COPY_SLUGS.indexOf(b));
}
