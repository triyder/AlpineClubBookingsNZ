import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindMany = vi.fn();
vi.mock("@/lib/prisma", () => ({
  prisma: { pageContent: { findMany: (...args: unknown[]) => mockFindMany(...args) } },
}));

import {
  isHoldCopyStale,
  detectStaleHoldPolicyCopy,
  holdCopyTitle,
} from "@/lib/hold-policy-copy";

// Pre-toggle wording (customised club that the migration could not refresh).
const STALE_TERMS =
  '<h2>Non-Member Priority System</h2><p>Bookings including non-members made more than 7 days before check-in are held as &ldquo;Pending&rdquo; and may be bumped.</p>';
// Post-toggle wording that names the new option.
const FRESH_TERMS =
  '<h2>Non-Member Booking Priority</h2><p><strong>Members First:</strong> non-member guests outside the threshold are held as Pending. <strong>First Paid, First In:</strong> non-member guests pay immediately.</p>';

describe("isHoldCopyStale", () => {
  it("flags pre-toggle copy that describes holds but omits First Paid, First In", () => {
    expect(isHoldCopyStale(STALE_TERMS)).toBe(true);
  });

  it("does not flag copy that already mentions First Paid, First In", () => {
    expect(isHoldCopyStale(FRESH_TERMS)).toBe(false);
  });

  it("is case-insensitive about the First Paid, First In marker", () => {
    const upper = STALE_TERMS + "<p>FIRST PAID, FIRST IN applies when disabled.</p>";
    expect(isHoldCopyStale(upper)).toBe(false);
  });

  it("does not flag copy unrelated to non-member holds", () => {
    expect(isHoldCopyStale("<p>Quiet hours are from 10pm to 7am.</p>")).toBe(false);
  });

  it("treats empty or missing content as not stale", () => {
    expect(isHoldCopyStale("")).toBe(false);
    expect(isHoldCopyStale(null)).toBe(false);
    expect(isHoldCopyStale(undefined)).toBe(false);
  });
});

describe("detectStaleHoldPolicyCopy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only the stale slugs, ordered terms then faq", async () => {
    mockFindMany.mockResolvedValue([
      { slug: "faq", contentHtml: STALE_TERMS },
      { slug: "terms", contentHtml: STALE_TERMS },
    ]);
    await expect(detectStaleHoldPolicyCopy()).resolves.toEqual(["terms", "faq"]);
  });

  it("excludes refreshed pages", async () => {
    mockFindMany.mockResolvedValue([
      { slug: "terms", contentHtml: FRESH_TERMS },
      { slug: "faq", contentHtml: STALE_TERMS },
    ]);
    await expect(detectStaleHoldPolicyCopy()).resolves.toEqual(["faq"]);
  });

  it("returns nothing when all copy is current or missing", async () => {
    mockFindMany.mockResolvedValue([{ slug: "terms", contentHtml: FRESH_TERMS }]);
    await expect(detectStaleHoldPolicyCopy()).resolves.toEqual([]);
  });
});

describe("holdCopyTitle", () => {
  it("maps slugs to human titles", () => {
    expect(holdCopyTitle("terms")).toBe("Terms of Service");
    expect(holdCopyTitle("faq")).toBe("FAQ");
  });
});
