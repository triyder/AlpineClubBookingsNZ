import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  pageContentFindUnique: vi.fn(),
  pageContentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    pageContent: {
      findUnique: mocks.pageContentFindUnique,
      findMany: mocks.pageContentFindMany,
    },
  },
}));

import {
  getSanitizedPageContentByPath,
  listWebsiteMenuPages,
  pageContentHtmlToPlainText,
  sanitizePageContentHtml,
} from "../page-content-html";

describe("sanitizePageContentHtml", () => {
  it("keeps allowed structural markup", () => {
    const html = '<h2>Rules</h2><p class="lead">Be <strong>kind</strong>.</p>';
    expect(sanitizePageContentHtml(html)).toBe(html);
  });

  it("keeps details/summary accordions, including the open state (#992)", () => {
    const closed =
      "<details><summary>How do I book?</summary><p>A</p></details>";
    expect(sanitizePageContentHtml(closed)).toBe(closed);

    const open =
      '<details open><summary class="faq-q">How do I book?</summary><p>A</p></details>';
    expect(sanitizePageContentHtml(open)).toBe(open);
  });

  it("strips disallowed attributes and handlers from details/summary", () => {
    expect(
      sanitizePageContentHtml(
        '<details ontoggle="alert(1)" style="position:fixed" name="grp">' +
          '<summary onclick="alert(1)" id="s" open>Q</summary><p>A</p></details>',
      ),
    ).toBe("<details><summary>Q</summary><p>A</p></details>");
  });

  it("strips script tags and their content", () => {
    expect(
      sanitizePageContentHtml('<p>ok</p><script>alert("x")</script>'),
    ).toBe("<p>ok</p>");
  });

  it("strips style tags and their content", () => {
    expect(
      sanitizePageContentHtml("<style>body{display:none}</style><p>ok</p>"),
    ).toBe("<p>ok</p>");
  });

  it("strips inline event handlers and style attributes", () => {
    expect(
      sanitizePageContentHtml(
        '<p onclick="alert(1)" style="position:fixed">ok</p>',
      ),
    ).toBe("<p>ok</p>");
  });

  it("strips javascript: links and forces rel on anchors", () => {
    expect(sanitizePageContentHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a rel="noopener noreferrer">x</a>',
    );
    expect(sanitizePageContentHtml('<a href="https://example.nz">x</a>')).toBe(
      '<a href="https://example.nz" rel="noopener noreferrer">x</a>',
    );
  });

  it("rejects protocol-relative image sources", () => {
    expect(sanitizePageContentHtml('<img src="//evil.example/x.png" />')).toBe(
      "<img />",
    );
    expect(sanitizePageContentHtml('<img src="/branding/lodge.jpg" />')).toBe(
      '<img src="/branding/lodge.jpg" />',
    );
  });

  it("keeps uploaded image library URLs but strips data: URIs (#731)", () => {
    expect(
      sanitizePageContentHtml('<img src="/api/images/abc123" alt="Hut" />'),
    ).toBe('<img src="/api/images/abc123" alt="Hut" />');

    expect(
      sanitizePageContentHtml(
        '<img src="https://example.nz/api/images/abc123" alt="Hut" />',
      ),
    ).toBe('<img src="https://example.nz/api/images/abc123" alt="Hut" />');

    expect(
      sanitizePageContentHtml(
        '<img src="data:image/png;base64,aGVsbG8=" alt="Hut" />',
      ),
    ).toBe('<img alt="Hut" />');
  });

  it("converts img style width/height to attributes", () => {
    expect(
      sanitizePageContentHtml(
        '<img src="/api/images/abc123" alt="Hut" style="width: 320px; height: 180px; border: 1px solid red;" />',
      ),
    ).toBe(
      '<img src="/api/images/abc123" alt="Hut" width="320" height="180" />',
    );
  });

  it("keeps safe svg polygon geometry/presentation and strips handlers, styles, and disallowed attributes", () => {
    const input =
      '<svg viewBox="0 0 100 100" width="100" height="100">' +
      '<polygon points="50,0 100,100 0,100" fill="red" stroke="black" ' +
      'stroke-width="2" onclick="alert(1)" style="fill:blue" id="p1" />' +
      "</svg>";

    const sanitized = sanitizePageContentHtml(input);

    // Geometry + presentation attributes survive.
    expect(sanitized).toContain("<polygon");
    expect(sanitized).toContain('points="50,0 100,100 0,100"');
    expect(sanitized).toContain('fill="red"');
    expect(sanitized).toContain('stroke="black"');
    expect(sanitized).toContain('stroke-width="2"');

    // The svg wrapper (with its lower-cased viewbox) is preserved.
    expect(sanitized).toContain('<svg viewbox="0 0 100 100"');

    // Event handlers, inline styles, and other disallowed attributes go.
    expect(sanitized).not.toContain("onclick");
    expect(sanitized).not.toContain("alert(1)");
    expect(sanitized).not.toContain("style=");
    expect(sanitized).not.toContain('id="p1"');

    // Sanitizing an already-sanitized value is a no-op (idempotent).
    expect(sanitizePageContentHtml(sanitized)).toBe(sanitized);
  });
});
// Issue #161 (ADR-003 residual): the lobby display's img-src CSP is tightened
// to 'self' data:, so its authoring/render path opts into a stricter <img> src
// constraint via { restrictImgSrc: true }. The CMS's own default (this option
// omitted) is the public-site page-content trust model and MUST stay exactly
// as covered by the describe block above — these tests only exercise the flag.
describe("sanitizePageContentHtml — display img-src restriction (issue #161)", () => {
  it("keeps the CMS default unaffected when the option is omitted (regression guard)", () => {
    // Mirrors the "keeps uploaded image library URLs but strips data: URIs"
    // case above: an absolute https image is still allowed by default.
    expect(
      sanitizePageContentHtml(
        '<img src="https://example.nz/api/images/abc123" alt="Hut" />',
      ),
    ).toBe('<img src="https://example.nz/api/images/abc123" alt="Hut" />');
  });

  it("blocks an absolute https <img> src (the ADR-003 exfiltration vector)", () => {
    expect(
      sanitizePageContentHtml(
        '<img src="https://evil.example/beacon.gif" alt="x" />',
        { restrictImgSrc: true },
      ),
    ).toBe('<img alt="x" />');
  });

  it("blocks a protocol-relative <img> src", () => {
    expect(
      sanitizePageContentHtml('<img src="//evil.example/beacon.gif" />', {
        restrictImgSrc: true,
      }),
    ).toBe("<img />");
  });

  it("keeps a relative / root-absolute <img> src (matches img-src 'self')", () => {
    expect(
      sanitizePageContentHtml('<img src="/api/images/abc123" alt="Hut" />', {
        restrictImgSrc: true,
      }),
    ).toBe('<img src="/api/images/abc123" alt="Hut" />');
  });

  it("keeps a data: <img> src (the CMS default strips it; the display variant keeps it)", () => {
    expect(
      sanitizePageContentHtml(
        '<img src="data:image/png;base64,aGVsbG8=" alt="Hut" />',
        { restrictImgSrc: true },
      ),
    ).toBe('<img src="data:image/png;base64,aGVsbG8=" alt="Hut" />');
  });

  it("still strips <script> and event handlers (CMS trust model unchanged by the flag)", () => {
    expect(
      sanitizePageContentHtml(
        '<p onclick="alert(1)">ok</p><script>alert(1)</script>',
        { restrictImgSrc: true },
      ),
    ).toBe("<p>ok</p>");
  });
});

describe("pageContentHtmlToPlainText", () => {
  it("strips markup and collapses whitespace", () => {
    expect(
      pageContentHtmlToPlainText("<p>Lodge   rules</p>\n<p>and notes</p>"),
    ).toBe("Lodge rules and notes");
  });
});

describe("getSanitizedPageContentByPath", () => {
  beforeEach(() => {
    mocks.pageContentFindUnique.mockReset();
  });

  it("returns null when no record exists", async () => {
    mocks.pageContentFindUnique.mockResolvedValue(null);
    await expect(getSanitizedPageContentByPath("/missing")).resolves.toBeNull();
  });

  it("sanitises both contentHtml and headerText on read", async () => {
    mocks.pageContentFindUnique.mockResolvedValue({
      id: "page-1",
      slug: "about",
      caption: "About",
      menuTitle: "About",
      title: "About",
      headerText: '<img src="x" onerror="alert(1)">Welcome',
      path: "/about",
      sortOrder: 10,
      contentHtml: "<p>ok</p><script>alert(1)</script>",
    });

    const page = await getSanitizedPageContentByPath("/about");

    expect(page?.contentHtml).toBe("<p>ok</p>");
    expect(page?.headerText).toBe('<img src="x" />Welcome');
  });
});

describe("listWebsiteMenuPages", () => {
  beforeEach(() => {
    mocks.pageContentFindMany.mockReset();
  });

  it("queries only published pages and keeps those with a menu title", async () => {
    mocks.pageContentFindMany.mockResolvedValue([
      { slug: "about", menuTitle: "About", title: "About", path: "/about" },
      { slug: "secret", menuTitle: "", title: "Secret", path: "/secret" },
    ]);

    const pages = await listWebsiteMenuPages();

    expect(mocks.pageContentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { published: true } }),
    );
    expect(pages.map((page) => page.slug)).toEqual(["about"]);
  });
});
