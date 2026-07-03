import { describe, it, expect, beforeEach } from "vitest";
import { starterPageContent } from "../../../prisma/starter-page-content";
import { checkRateLimitInMemory as checkRateLimit, _testStore } from "@/lib/rate-limit";
import { rateLimiters } from "@/lib/rate-limit";

// Note: Committee data tests moved to committee.test.ts (now database-driven)

// ─── FAQ data ──────────────────────────────────────────────────────────────

describe("faq page content (F-PUB-04)", () => {
  const faq = starterPageContent.find((page) => page.slug === "faq");

  it("is seeded as editable PageContent", () => {
    expect(faq).toBeDefined();
    expect(faq?.path).toBe("/faq");
    expect(faq?.title).toContain("Frequently Asked Questions");
  });

  it("keeps question and answer content in the CMS body", () => {
    expect(faq?.contentHtml).toContain("How do I book a stay at the lodge?");
    expect(faq?.contentHtml).toContain("Members can book directly");
  });

  it("covers required topics", () => {
    const body = faq?.contentHtml.toLowerCase() ?? "";

    expect(body).toContain("book");
    expect(body).toContain("cancellation");
    expect(body).toContain("member");
    expect(body).toContain("chore");
    expect(body).toContain("password");
  });

  it("wraps every question in a native details/summary accordion item (#992)", () => {
    const body = faq?.contentHtml ?? "";
    const detailsCount = (body.match(/<details>/g) ?? []).length;
    const summaryCount = (body.match(/<summary>/g) ?? []).length;

    expect(detailsCount).toBeGreaterThan(0);
    expect(summaryCount).toBe(detailsCount);
    // The flat pre-accordion markup used <h3> question headings.
    expect(body).not.toContain("<h3>");
  });
});

// ─── Contact rate limit (F-PUB-03) ─────────────────────────────────────────

describe("contact form rate limit (F-PUB-03)", () => {
  beforeEach(() => {
    _testStore.clear();
  });

  it("allows 10 submissions per hour", () => {
    const config = rateLimiters.contact;
    expect(config.limit).toBe(10);
    expect(config.windowSeconds).toBe(3600);

    for (let i = 0; i < 10; i++) {
      const result = checkRateLimit(config, "192.168.1.1");
      expect(result.success).toBe(true);
    }
  });

  it("blocks the 11th submission", () => {
    const config = rateLimiters.contact;

    for (let i = 0; i < 10; i++) {
      checkRateLimit(config, "10.0.0.1");
    }

    const result = checkRateLimit(config, "10.0.0.1");
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("different IPs have independent limits", () => {
    const config = rateLimiters.contact;

    for (let i = 0; i < 10; i++) {
      checkRateLimit(config, "10.0.0.1");
    }

    // Different IP should still be allowed
    const result = checkRateLimit(config, "10.0.0.2");
    expect(result.success).toBe(true);
  });
});

// ─── Privacy & Terms pages metadata ────────────────────────────────────────

describe("compliance pages (F-COMP-01, F-COMP-02)", () => {
  it("privacy page is seeded as editable PageContent", () => {
    const page = starterPageContent.find((item) => item.slug === "privacy");

    expect(page).toBeDefined();
    expect(page?.path).toBe("/privacy");
    expect(page?.title.toLowerCase()).toContain("privacy");
    expect(page?.contentHtml).toContain("Privacy Act 2020");
    expect(page?.contentHtml).toContain("Google Analytics 4");
    expect(page?.contentHtml).toContain("Consent Mode starts with analytics storage denied");
  });

  it("terms page is seeded as editable PageContent", () => {
    const page = starterPageContent.find((item) => item.slug === "terms");

    expect(page).toBeDefined();
    expect(page?.path).toBe("/terms");
    expect(page?.title.toLowerCase()).toContain("terms");
    expect(page?.contentHtml).toContain("Terms of Service");
  });
});
