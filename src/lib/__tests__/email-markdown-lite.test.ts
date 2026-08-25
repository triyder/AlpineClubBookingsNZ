import { describe, expect, it } from "vitest";

import {
  applyInlineMarkdownLite,
  classifyMarkdownLiteLine,
  containsMarkdownLiteSyntax,
} from "@/lib/email-markdown-lite";
import {
  markdownLiteEmailTemplate,
  multilineBlock,
  plainTextEmailTemplate,
} from "@/lib/email-templates/layout";
import { renderEmailTemplatePreview } from "@/lib/email-message-renderer";

/**
 * Markdown-lite for admin-editable email bodies (fork #38).
 *
 * The two properties everything else leans on: (1) the vocabulary renders as
 * styled HTML while raw HTML typed into a body stays inert text, and (2) a
 * body containing NO syntax renders through the markdown template in exactly
 * the shape the plain template produces — which is what makes re-saving an
 * unformatted body visually a no-op.
 */

describe("applyInlineMarkdownLite", () => {
  it("renders bold then italic, leaving unmatched and empty markers literal", () => {
    expect(applyInlineMarkdownLite("a **bold** and *italic* word")).toBe(
      "a <strong>bold</strong> and <em>italic</em> word",
    );
    expect(applyInlineMarkdownLite("2 * 3 = 6 and 4 ** 2")).toBe(
      "2 * 3 = 6 and 4 ** 2",
    );
    expect(applyInlineMarkdownLite("****")).toBe("****");
    // The vocabulary is deliberately FLAT — no nesting. A doubled marker
    // around an inner pair is not bold-with-italic; the inner pair renders
    // and the outer markers stay literal, which Preview shows plainly.
    expect(applyInlineMarkdownLite("**bold *and* nested**")).toBe(
      "**bold <em>and</em> nested**",
    );
  });

  it("never introduces markup beyond strong/em — input arrives pre-escaped", () => {
    // The caller escapes first, so what looks like HTML is entity text here.
    expect(applyInlineMarkdownLite("&lt;script&gt;**x**&lt;/script&gt;")).toBe(
      "&lt;script&gt;<strong>x</strong>&lt;/script&gt;",
    );
  });
});

describe("classifyMarkdownLiteLine", () => {
  it("binds #, ## and - only at line start", () => {
    expect(classifyMarkdownLiteLine("# Heading")).toEqual({
      kind: "heading",
      level: 2,
      text: "Heading",
    });
    expect(classifyMarkdownLiteLine("## Sub")).toEqual({
      kind: "heading",
      level: 3,
      text: "Sub",
    });
    expect(classifyMarkdownLiteLine("- item")).toEqual({
      kind: "bullet",
      text: "item",
    });
    // Mid-line markers are ordinary text: money, ranges, hashtags.
    expect(classifyMarkdownLiteLine("Total: -$3.00").kind).toBe("text");
    expect(classifyMarkdownLiteLine("check-in - check-out").kind).toBe("text");
    expect(classifyMarkdownLiteLine("Ref #123").kind).toBe("text");
    // A marker with no following space is not syntax.
    expect(classifyMarkdownLiteLine("#hashtag").kind).toBe("text");
    expect(classifyMarkdownLiteLine("-dash").kind).toBe("text");
  });
});

describe("markdownLiteEmailTemplate", () => {
  const BODY = [
    "Booking Confirmed",
    "",
    "# Your stay",
    "Hi **Sam**, your *lodge* booking is confirmed.",
    "",
    "## What to bring",
    "- Warm layers",
    "- A **sleeping bag** liner",
    "",
    "See you up the mountain.",
  ].join("\n");

  it("renders headings, bullets and inline styling inside the themed shell", () => {
    const html = markdownLiteEmailTemplate(BODY);
    expect(html).toContain(">Your stay</h2>");
    expect(html).toContain(">What to bring</h3>");
    expect(html).toContain("<strong>Sam</strong>");
    expect(html).toContain("<em>lodge</em>");
    expect(html).toContain("<li");
    expect(html).toContain("<strong>sleeping bag</strong> liner");
    expect(html).toContain("See you up the mountain.");
  });

  it("keeps raw HTML typed into a body inert — angle brackets render literally", () => {
    const html = markdownLiteEmailTemplate(
      'Heading\n\n<img src=x onerror=alert(1)> and **bold**',
    );
    // The themed shell carries its own logo <img>; what must never appear is
    // the body's tag UNESCAPED.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders a syntax-free body in exactly the plain template's shape", () => {
    const plainBody =
      "Booking Confirmed\n\nHi Sam, your booking is confirmed.\nCheck-in: 2026-08-01\n\nSee you soon.";
    expect(containsMarkdownLiteSyntax(plainBody)).toBe(false);
    expect(markdownLiteEmailTemplate(plainBody)).toBe(
      plainTextEmailTemplate(plainBody),
    );
  });

  it("keeps multi-line block-token output (label: value lines) as plain text", () => {
    // The {{ical}}/{{promoSummary}} shape: label-and-value lines, none of
    // which start with a marker — they must pass through untouched.
    const tokenBlock =
      "Heading\n\nAdd this stay to your calendar\nCalendar file (.ics): https://example.org/x?token=abc\nGoogle Calendar: https://example.org/y";
    const html = markdownLiteEmailTemplate(tokenBlock);
    expect(html).toBe(plainTextEmailTemplate(tokenBlock));
    expect(html).toContain(
      multilineBlock(
        "Add this stay to your calendar\nCalendar file (.ics): https://example.org/x?token=abc\nGoogle Calendar: https://example.org/y",
      ),
    );
  });
});

describe("renderEmailTemplatePreview honours the flag", () => {
  it("renders formatting only when bodyMarkdown is true", async () => {
    const bodyText = "Heading\n\nHi {{firstName}}, **see you soon**.";
    const formatted = await renderEmailTemplatePreview({
      templateName: "booking-confirmed",
      subject: "Subject",
      bodyText,
      bodyMarkdown: true,
    });
    expect(formatted.html).toContain("<strong>see you soon</strong>");

    const plain = await renderEmailTemplatePreview({
      templateName: "booking-confirmed",
      subject: "Subject",
      bodyText,
    });
    expect(plain.html).not.toContain("<strong>see you soon</strong>");
    expect(plain.html).toContain("**see you soon**");
  });
});
