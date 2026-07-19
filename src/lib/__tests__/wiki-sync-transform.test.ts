import { describe, expect, it } from "vitest";
import {
  banner,
  buildSidebar,
  buildWiki,
  firstH1,
  pageNameFromTitle,
  readingOrderFromIndex,
  repoSlugFromPackageJson,
  rewriteTarget,
  transformContent,
} from "../../../scripts/sync-user-guide-wiki.mjs";

const SLUG = "thatskiff33/AlpineClubBookingsNZ";

function ctx(pages: Record<string, string> = {}) {
  return {
    slug: SLUG,
    pageMap: new Map(Object.entries({ "README.md": "Home", ...pages })),
  };
}

describe("wiki sync transforms", () => {
  it("derives the repo slug from package.json", () => {
    expect(
      repoSlugFromPackageJson(
        JSON.stringify({ repository: { url: "git+https://github.com/thatskiff33/AlpineClubBookingsNZ.git" } }),
      ),
    ).toBe(SLUG);
  });

  it("builds wiki page names from guide H1 titles", () => {
    expect(pageNameFromTitle("Joining the club")).toBe("Joining-the-club");
    expect(pageNameFromTitle("Managing your family & household")).toBe(
      "Managing-your-family-and-household",
    );
    expect(pageNameFromTitle("The waitlist & offers")).toBe("The-waitlist-and-offers");
  });

  it("rewrites sibling guide links to wiki pages, keeping anchors", () => {
    const c = ctx({ "booking-a-stay.md": "Booking-a-stay" });
    expect(rewriteTarget("booking-a-stay.md", c)).toBe("Booking-a-stay");
    expect(rewriteTarget("booking-a-stay.md#3-review-confirm", c)).toBe(
      "Booking-a-stay#3-review-confirm",
    );
    expect(rewriteTarget("README.md", c)).toBe("Home");
  });

  it("rewrites repo-relative doc links to absolute blob URLs, keeping anchors", () => {
    expect(rewriteTarget("../CANCELLATIONS.md#refund-policy", ctx())).toBe(
      `https://github.com/${SLUG}/blob/main/docs/CANCELLATIONS.md#refund-policy`,
    );
  });

  it("rewrites directory links to tree URLs", () => {
    expect(rewriteTarget("../guides/", ctx())).toBe(
      `https://github.com/${SLUG}/tree/main/docs/guides/`,
    );
  });

  it("rewrites image embeds to raw URLs", () => {
    expect(rewriteTarget("../images/public/member-book.png", ctx())).toBe(
      `https://raw.githubusercontent.com/${SLUG}/main/docs/images/public/member-book.png`,
    );
  });

  it("leaves absolute URLs, mailto, and in-page anchors untouched", () => {
    for (const target of ["https://example.org/x", "mailto:x@y.nz", "#what-it-is"]) {
      expect(rewriteTarget(target, ctx())).toBe(target);
    }
  });

  it("throws when a link escapes the repository root rather than guessing", () => {
    expect(() => rewriteTarget("../../../etc/passwd", ctx())).toThrow(/escapes/);
  });

  it("rewrites reference-style link definitions", () => {
    const c = ctx({ "booking-a-stay.md": "Booking-a-stay" });
    expect(transformContent("[book]: booking-a-stay.md\n[deep]: ../CANCELLATIONS.md#refund-policy", c)).toBe(
      `[book]: Booking-a-stay\n[deep]: https://github.com/${SLUG}/blob/main/docs/CANCELLATIONS.md#refund-policy`,
    );
  });

  it("transforms every link and image in a page body", () => {
    const c = ctx({ "your-account.md": "Managing-your-account" });
    const out = transformContent(
      "See [account](your-account.md#security) and " +
        "![Dashboard showing cards](../images/public/member-dashboard.png) " +
        "plus [invariants](../DOMAIN_INVARIANTS.md).",
      c,
    );
    expect(out).toBe(
      "See [account](Managing-your-account#security) and " +
        `![Dashboard showing cards](https://raw.githubusercontent.com/${SLUG}/main/docs/images/public/member-dashboard.png) ` +
        `plus [invariants](https://github.com/${SLUG}/blob/main/docs/DOMAIN_INVARIANTS.md).`,
    );
  });

  it("orders the sidebar by first appearance in the index and appends stragglers", () => {
    const order = readingOrderFromIndex(
      "- [Join](joining-the-club.md)\n- [Book](booking-a-stay.md)\n- [Join again](joining-the-club.md)",
      ["booking-a-stay.md", "joining-the-club.md", "your-account.md"],
    );
    expect(order).toEqual(["joining-the-club.md", "booking-a-stay.md", "your-account.md"]);
  });

  it("stamps every generated page with the managed marker", () => {
    expect(banner("booking-a-stay.md", SLUG).startsWith("<!-- managed-by:sync-user-guide-wiki")).toBe(true);
    expect(
      buildSidebar(
        ["a.md"],
        new Map([["a.md", "A"]]),
        new Map([["a.md", "A title"]]),
        SLUG,
      ).startsWith("<!-- managed-by:sync-user-guide-wiki"),
    ).toBe(true);
  });

  it("builds the full wiki set from sources, README becoming Home", () => {
    const wiki = buildWiki(
      {
        "README.md": "# Index\n\n- [Join](joining-the-club.md)",
        "joining-the-club.md": "# Joining the club\n\nBody [index](README.md).",
      },
      SLUG,
    );
    expect([...wiki.keys()].sort()).toEqual([
      "Home.md",
      "Joining-the-club.md",
      "_Footer.md",
      "_Sidebar.md",
    ]);
    expect(wiki.get("Home.md")).toContain("](Joining-the-club)");
    expect(wiki.get("Joining-the-club.md")).toContain("](Home)");
  });

  it("mirrors the real docs/user-guide tree without throwing and maps every page", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(process.cwd(), "docs/user-guide");
    const sources = Object.fromEntries(
      fs
        .readdirSync(dir)
        .filter((f: string) => f.endsWith(".md"))
        .map((f: string) => [f, fs.readFileSync(path.join(dir, f), "utf8")]),
    );
    const wiki = buildWiki(sources, SLUG);
    expect(wiki.size).toBe(Object.keys(sources).length + 2); // pages + sidebar + footer
    for (const [name, content] of wiki) {
      expect(content, name).not.toMatch(/\](\(|:\s*)(\.\.?\/|[A-Za-z0-9-]+\.md)/);
    }
  });

  it("finds the first H1", () => {
    expect(firstH1("intro\n# Title here\n## sub")).toBe("Title here");
    expect(firstH1("no heading")).toBeNull();
  });
});
