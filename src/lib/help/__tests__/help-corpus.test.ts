import { describe, expect, it } from "vitest";
import {
  getContextualHelp,
  getContextualHelpPaths,
} from "@/lib/contextual-help";
import { getHelpForPage, getHelpPaths } from "@/lib/help";
import { buildHelpGrounding } from "@/lib/help/grounding";
import { BOOK_WIZARD_STEP_IDS } from "@/lib/help/member-help";
import type { HelpPageContent, HelpSurface } from "@/lib/help/types";

function collectText(content: HelpPageContent): string {
  const parts: string[] = [content.title, content.summary, ...content.actions];
  for (const field of content.fields ?? []) {
    parts.push(field.name, field.description);
  }
  for (const section of content.sections ?? []) {
    parts.push(section.title, ...section.details);
  }
  parts.push(...(content.notes ?? []));
  for (const question of content.questions ?? []) {
    parts.push(question.q, question.a);
    if (question.link) {
      parts.push(question.link.label, question.link.href);
    }
  }
  return parts.join("\n");
}

describe("admin/finance parity with the existing registry", () => {
  it("returns the identical content object for every admin path", () => {
    for (const path of getContextualHelpPaths("admin")) {
      expect(getHelpForPage("admin", path)).toBe(
        getContextualHelp(path, "admin"),
      );
    }
  });

  it("returns the identical content object for every finance path", () => {
    for (const path of getContextualHelpPaths("finance")) {
      expect(getHelpForPage("finance", path)).toBe(
        getContextualHelp(path, "finance"),
      );
    }
  });

  it("exposes the same paths through getHelpPaths", () => {
    expect(getHelpPaths("admin")).toEqual(getContextualHelpPaths("admin"));
    expect(getHelpPaths("finance")).toEqual(getContextualHelpPaths("finance"));
  });
});

describe("member guide parity", () => {
  // Each of the seven member guides is distilled into at least one corpus entry.
  const GUIDE_TO_MEMBER_PATH: Record<string, string> = {
    "booking-a-stay.md": "/book",
    "paying-for-your-stay.md": "/bookings/abc123",
    "waitlist-and-offers.md": "/bookings",
    "changing-or-cancelling-a-booking.md": "/bookings/abc123",
    "your-account.md": "/profile",
    "managing-your-family.md": "/profile",
    "joining-the-club.md": "/dashboard",
  };

  it("maps every guide to an existing member entry with at least 3 questions", () => {
    for (const [guide, path] of Object.entries(GUIDE_TO_MEMBER_PATH)) {
      const content = getHelpForPage("member", path);
      expect(content.title, `${guide} -> ${path} should not be the fallback`).not.toBe(
        "Member help",
      );
      expect(
        content.questions?.length ?? 0,
        `${guide} -> ${path} needs >= 3 questions`,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("question integrity across all surfaces", () => {
  const surfaces: HelpSurface[] = ["public", "member", "admin", "finance"];

  it("every question has non-empty q and a", () => {
    for (const surface of surfaces) {
      const paths = [...getHelpPaths(surface), "/definitely-not-a-real-page"];
      for (const path of paths) {
        const content = getHelpForPage(surface, path);
        for (const question of content.questions ?? []) {
          expect(question.q.trim().length, `${surface} ${path}`).toBeGreaterThan(0);
          expect(question.a.trim().length, `${surface} ${path}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every /book question is tagged with a real wizard step id", () => {
    const content = getHelpForPage("member", "/book");
    const groups = (content.questions ?? []).map((question) => question.group);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group, "each /book question needs a group").toBeDefined();
      expect(BOOK_WIZARD_STEP_IDS).toContain(group);
    }
  });
});

describe("public corpus hygiene", () => {
  const CLUB_PROPER_NOUNS = /tokoroa|LWTC|hoppers|example mountain/i;
  const AI_WORDING = /\bAI\b|assistant/i;

  it("never names a specific club and never mentions AI or an assistant", () => {
    const contents = [
      getHelpForPage("public", "/"),
      getHelpForPage("public", "/an-unknown-public-page"),
    ];
    for (const content of contents) {
      const text = collectText(content);
      expect(text).not.toMatch(CLUB_PROPER_NOUNS);
      expect(text).not.toMatch(AI_WORDING);
    }
  });
});

describe("/x/* detail matcher", () => {
  it("routes a detail path to the /bookings/* entry", () => {
    expect(getHelpForPage("member", "/bookings/abc123").title).toBe("Your booking");
  });

  it("routes the bare list path to the /bookings entry", () => {
    expect(getHelpForPage("member", "/bookings").title).toBe("My Bookings");
  });

  it("keeps distinguishing list from detail after trailing-slash normalisation", () => {
    expect(getHelpForPage("member", "/bookings/").title).toBe("My Bookings");
    expect(getHelpForPage("member", "/bookings/abc123?tab=guests").title).toBe(
      "Your booking",
    );
  });

  it("does not treat a shared string prefix as a path prefix", () => {
    expect(getHelpForPage("member", "/bookingsfoo").title).toBe("Member help");
  });

  it("routes nested detail paths to the /bookings/* entry", () => {
    expect(getHelpForPage("member", "/bookings/a/b").title).toBe("Your booking");
  });
});

describe("buildHelpGrounding", () => {
  const ARTIFACTS = /=>|function\s|<\/|className|React\.|\[object Object\]|undefined/;
  const CASES: Array<{ surface: HelpSurface; path: string; title: string }> = [
    { surface: "public", path: "/", title: "Welcome" },
    { surface: "member", path: "/book", title: "Book a Stay" },
    { surface: "member", path: "/bookings/abc123", title: "Your booking" },
    { surface: "admin", path: "/admin/bookings", title: "Bookings" },
    { surface: "finance", path: "/finance", title: "Finance Dashboard" },
  ];

  for (const { surface, path, title } of CASES) {
    it(`serializes ${surface} ${path} as clean labelled text`, () => {
      const grounding = buildHelpGrounding(surface, path);
      expect(grounding.startsWith(`# ${title}`)).toBe(true);
      expect(grounding).toContain("## Questions and answers");
      expect(grounding).toContain("Q: ");
      expect(grounding).toContain("A: ");
      expect(grounding).not.toMatch(ARTIFACTS);
    });
  }

  it("emits a stable, readable grounding for the public home page", () => {
    expect(buildHelpGrounding("public", "/")).toMatchInlineSnapshot(`
      "# Welcome

      This is the club's booking website. Members sign in to book a stay and manage their account; if you are not a member yet, you can apply to join or ask the club for a booking as a guest.

      ## What you can do
      - Members: use Log In, then open Book to reserve lodge nights.
      - Not a member yet: use the Join or Apply link to start a membership application.
      - Staying as a guest: use the request-a-booking option on the sign-in page to ask the club for a quote.

      ## Questions and answers
      Q: How do I book a stay?
      A: If you are a member, sign in and open Book to choose your nights and confirm. If you are not a member, apply to join first, or use the request-a-booking option to ask the club for a guest quote.

      Q: How do I become a member?
      A: Use the Join or Apply link to fill in a membership application. Applying does not create a login — the club reviews and approves applications before you can sign in.

      Q: Can I stay without being a member?
      A: Yes. From the sign-in page you can request a booking without an account, and the club replies with a secure quote you can accept.

      Q: Where do I find fees, dates, or the cancellation policy?
      A: Those are set by the club. Check the club's own pages in the site menu or footer, or use the club's contact page to ask directly."
    `);
  });
});

describe("fallbacks for unknown paths", () => {
  it("returns each surface's fallback for an unmapped path", () => {
    expect(getHelpForPage("admin", "/admin/not-a-page").title).toBe("Admin Help");
    // A path outside the single "/finance" prefix falls back (a "/finance/..."
    // path would still longest-prefix-match the Finance Dashboard entry).
    expect(getHelpForPage("finance", "/reporting-workspace").title).toBe(
      "Finance Help",
    );
    expect(getHelpForPage("member", "/not-a-member-page").title).toBe(
      "Member help",
    );
    expect(getHelpForPage("public", "/not-a-public-page").title).toBe("Help");
  });
});
