import { describe, expect, it } from "vitest";
import { MODULE_KEYS } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import {
  getAdminFeatureSearchIndex,
  getVisibleAdminNavSections,
} from "@/components/admin-sidebar";

const allOn: FeatureFlags = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

function matrix(
  over: Partial<Record<keyof AdminPermissionMatrix, "none" | "view" | "edit">>,
): AdminPermissionMatrix {
  return {
    overview: "none",
    bookings: "none",
    membership: "none",
    finance: "none",
    lodge: "none",
    content: "none",
    support: "none",
    ...over,
  };
}

const fullMatrix = matrix({
  overview: "edit",
  bookings: "edit",
  membership: "edit",
  finance: "edit",
  lodge: "edit",
  content: "edit",
  support: "edit",
});

/**
 * The invariant, expressed as a test seam: the palette index MUST expose
 * exactly the (de-duplicated) set of hrefs the sidebar's
 * getVisibleAdminNavSections would show the same admin — no more, no less.
 */
function visibleHrefs(
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
  isFullAdmin?: boolean,
  hutLeaderLabel = "Hut Leader",
): Set<string> {
  return new Set(
    getVisibleAdminNavSections(
      features,
      permissionMatrix,
      isFullAdmin,
      hutLeaderLabel,
    ).flatMap((section) => section.items.map((item) => item.href)),
  );
}

describe("getAdminFeatureSearchIndex — derivation", () => {
  it("indexes every visible nav page exactly once (no duplicates across sections)", () => {
    const index = getAdminFeatureSearchIndex(allOn, fullMatrix, true);
    const hrefs = index.map((entry) => entry.href);

    // De-duplicated: "Needs Attention" re-lists pages from their home sections,
    // but each page appears exactly once in the index.
    expect(new Set(hrefs).size).toBe(hrefs.length);
    // Covers exactly the set the sidebar would render — the single source of truth.
    expect(new Set(hrefs)).toEqual(visibleHrefs(allOn, fullMatrix, true));
  });

  it("labels a de-duplicated page by its natural section, not Needs Attention", () => {
    const index = getAdminFeatureSearchIndex(allOn, fullMatrix, true);
    const bookingRequests = index.find(
      (entry) => entry.href === "/admin/booking-requests",
    );

    expect(bookingRequests?.section).toBe("Bookings & Beds");
  });

  it("carries the hut-leader relabel through from getVisibleAdminNavSections", () => {
    const index = getAdminFeatureSearchIndex(
      allOn,
      fullMatrix,
      true,
      "Warden",
    );
    const hutLeaders = index.find(
      (entry) => entry.href === "/admin/hut-leaders",
    );

    expect(hutLeaders?.label).toBe("Wardens");
  });

  it("carries optional keywords through to the index entry", () => {
    const index = getAdminFeatureSearchIndex(allOn, fullMatrix, true);
    const xero = index.find((entry) => entry.href === "/admin/xero");

    expect(xero?.keywords).toContain("accounting");
  });
});

describe("getAdminFeatureSearchIndex — permission filtering (the invariant)", () => {
  it("matches getVisibleAdminNavSections for a limited (bookings-only) matrix", () => {
    const limited = matrix({ bookings: "view" });
    const index = getAdminFeatureSearchIndex(allOn, limited, false);
    const hrefs = new Set(index.map((entry) => entry.href));

    expect(hrefs).toEqual(visibleHrefs(allOn, limited, false));
    // Bookings pages are in; other areas are out.
    expect(hrefs.has("/admin/bookings")).toBe(true);
    expect(hrefs.has("/admin/members")).toBe(false);
    // fullAdminOnly export/import never leaks to a non-full-admin.
    expect(hrefs.has("/admin/config-transfer")).toBe(false);
  });

  it("hides fullAdminOnly pages from a non-full-admin even with support edit (no matrix leak)", () => {
    const supportEditor = matrix({ support: "edit" });

    const asNonFullAdmin = new Set(
      getAdminFeatureSearchIndex(allOn, supportEditor, false).map(
        (entry) => entry.href,
      ),
    );
    const asFullAdmin = new Set(
      getAdminFeatureSearchIndex(allOn, supportEditor, true).map(
        (entry) => entry.href,
      ),
    );

    // The support matrix alone would satisfy the /admin/config-transfer prefix
    // requirement; fullAdminOnly must still gate it. This is the exact leak the
    // invariant warns about.
    expect(asNonFullAdmin.has("/admin/config-transfer")).toBe(false);
    expect(asNonFullAdmin.has("/admin/access-roles")).toBe(false);
    // A full admin with the same matrix sees them.
    expect(asFullAdmin.has("/admin/config-transfer")).toBe(true);
    expect(asFullAdmin.has("/admin/access-roles")).toBe(true);
  });

  it("honours the orAccess predicate for /admin/fees (finance-only view reaches it)", () => {
    const financeOnly = matrix({ finance: "view" });
    const index = getAdminFeatureSearchIndex(allOn, financeOnly, false);
    const hrefs = new Set(index.map((entry) => entry.href));

    // /admin/fees resolves to the bookings prefix, but its orAccess admits a
    // finance-only viewer — the palette must match that OR rule, not the prefix.
    expect(hrefs.has("/admin/fees")).toBe(true);
    expect(hrefs).toEqual(visibleHrefs(allOn, financeOnly, false));

    // Neither bookings nor finance → no Fees entry.
    const membershipOnly = matrix({ membership: "view" });
    const membershipHrefs = new Set(
      getAdminFeatureSearchIndex(allOn, membershipOnly, false).map(
        (entry) => entry.href,
      ),
    );
    expect(membershipHrefs.has("/admin/fees")).toBe(false);
  });

  it("fails closed: an undefined permission matrix yields an EMPTY index (deny by default)", () => {
    // Defence in depth (#2092): getVisibleAdminNavSections fails OPEN on a
    // missing matrix (its pre-existing, shared contract), but the palette index
    // must NOT — a missing matrix returns nothing rather than every page.
    expect(getAdminFeatureSearchIndex(allOn, undefined, true)).toEqual([]);
    expect(getAdminFeatureSearchIndex(allOn, undefined, false)).toEqual([]);
    // The sidebar seam still fails open, so this is genuinely palette-scoped.
    expect(
      getVisibleAdminNavSections(allOn, undefined, true).length,
    ).toBeGreaterThan(0);
  });

  it("respects module-flag visibility (a disabled module drops its pages)", () => {
    const xeroOff = { ...allOn, xeroIntegration: false } as FeatureFlags;
    const index = getAdminFeatureSearchIndex(xeroOff, fullMatrix, true);
    const hrefs = new Set(index.map((entry) => entry.href));

    expect(hrefs.has("/admin/xero")).toBe(false);
    expect(hrefs).toEqual(visibleHrefs(xeroOff, fullMatrix, true));
  });
});
