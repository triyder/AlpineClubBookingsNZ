import { describe, expect, it } from "vitest";
import sanitizeHtml from "sanitize-html";

describe("discarded iframe fallback sanitization (GHSA-c9rx-x947-fp3h)", () => {
  it("handles deeply nested discarded iframes without exhausting the stack", () => {
    expect(() => sanitizeHtml("<iframe>".repeat(20_000))).not.toThrow();
  });

  it("enforces the nesting limit across discarded iframe fallbacks", () => {
    const input = ("<iframe>" + "<b>".repeat(3)).repeat(50) + "x";
    const output = sanitizeHtml(input, { allowedTags: ["b"], nestingLimit: 3 });
    let depth = 0;
    let deepest = 0;
    for (const tag of output.match(/<\/?b>/g) ?? []) {
      depth += tag === "<b>" ? 1 : -1;
      deepest = Math.max(deepest, depth);
    }
    expect(deepest).toBeLessThanOrEqual(3);
    expect(sanitizeHtml("<b>ordinary text</b>", { allowedTags: ["b"], nestingLimit: 3 }))
      .toBe("<b>ordinary text</b>");
  });
});
