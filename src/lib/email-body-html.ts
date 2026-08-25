import sanitizeHtml from "sanitize-html";
import { escapeHtml } from "@/lib/email-templates/escape";

/**
 * Rich email bodies (fork #38, owner decision 25 Aug 2026: the email body
 * editor works like the /message-board composer — in-place styling, stored
 * as sanitised HTML).
 *
 * THE POLICY IS THE CONTROL, exactly as `club-post-html.ts` puts it for the
 * message board: the editor is convenience, and everything an admin submits
 * is reduced to this allowlist on SAVE and again at RENDER (defence in
 * depth). The vocabulary is deliberately smaller than the message board's —
 * bold/italic/underline, bullet and numbered lists, and block text-align —
 * because an email must stay on the club theme in every mail client: no
 * colours, fonts, sizes, images or links in v1 (each is a possible
 * follow-up, and the message board's colour/font CLASSES have no
 * inline-style mapping a mail client could read anyway).
 *
 * `{{token}}` markers are plain text to this policy and pass through
 * untouched; substitution happens at render time with every VALUE
 * HTML-escaped, so no token value can smuggle markup into the body it lands
 * in.
 */

const EMAIL_BODY_TAGS = [
  "p",
  "div",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "ul",
  "ol",
  "li",
  "span",
];

const TEXT_ALIGN_VALUES = [/^left$/, /^right$/, /^center$/];

const SAVE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: EMAIL_BODY_TAGS,
  allowedAttributes: {
    p: ["style"],
    div: ["style"],
  },
  allowedStyles: {
    "*": { "text-align": TEXT_ALIGN_VALUES },
  },
  // Text outside any tag is fine; disallowed tags drop but their TEXT
  // survives (sanitize-html's default), so pasting rich content degrades to
  // its words rather than vanishing.
};

export function sanitiseEmailBodyHtml(input: string): string {
  if (typeof input !== "string" || input.trim() === "") return "";
  return sanitizeHtml(input, SAVE_OPTIONS).trim();
}

/**
 * The plain-text form of a rich body — the `clubPostHtmlToText` pattern.
 * Fills `bodyText` on save, so audit rows, the stale-content diff, and token
 * validation (allowed/required/sensitive) keep operating on text with line
 * structure that matches how the body reads.
 */
export function emailBodyHtmlToText(html: string): string {
  if (typeof html !== "string" || html.trim() === "") return "";
  // A closing paragraph is a BLOCK boundary (blank line), so the plain-path
  // conventions the derived text feeds — blank-line blocks, the diff, token
  // validation — read the way the rich body looks. Lines inside a block
  // (<br>, list items, divs) are single newlines.
  const withBreaks = html
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/(div|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
  });
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Substitute `{{token}}` values into a SANITISED HTML body. Every value is
 * HTML-escaped, and a multi-line pre-composed block value (promoSummary,
 * paymentOutcome, ical…) keeps its line structure as `<br>`s. An absent or
 * null value renders as nothing, matching the plain-text path's convention.
 */
export function renderHtmlTemplateString(
  html: string,
  data: Record<string, string | number | boolean | null | undefined>,
): string {
  return html.replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
    const value = data[tokenName.trim()];
    if (value === null || value === undefined) return "";
    return escapeHtml(String(value)).replace(/\r?\n/g, "<br>");
  });
}

// Inline spacing mail clients would otherwise not apply — the shell's cell
// carries the font, colour and size, which these children inherit.
const RENDER_STYLE: Record<string, string> = {
  p: "margin: 0 0 12px 0; line-height: 1.6;",
  div: "margin: 0 0 12px 0; line-height: 1.6;",
  ul: "margin: 0 0 12px 0; padding-left: 22px;",
  ol: "margin: 0 0 12px 0; padding-left: 22px;",
  li: "margin: 0 0 4px 0;",
};

/**
 * The final render pass over a rich body with tokens already substituted:
 * re-sanitise (defence in depth — the stored copy should already be clean)
 * and stamp the inline spacing styles a mail client needs, preserving any
 * allowlisted text-align the author set.
 */
export function renderEmailBodyHtml(substitutedHtml: string): string {
  const transformTags: sanitizeHtml.IOptions["transformTags"] =
    Object.fromEntries(
      Object.entries(RENDER_STYLE).map(([tag, style]) => [
        tag,
        (tagName: string, attribs: sanitizeHtml.Attributes) => ({
          tagName,
          attribs: {
            ...attribs,
            style: attribs.style ? `${style} ${attribs.style}` : style,
          },
        }),
      ]),
    );
  return sanitizeHtml(substitutedHtml, {
    ...SAVE_OPTIONS,
    // The render pass ADDS the spacing styles, so the style allowlist widens
    // to exactly what RENDER_STYLE stamps plus the author's text-align.
    allowedStyles: {
      "*": {
        "text-align": TEXT_ALIGN_VALUES,
        margin: [/^0 0 (?:4|12)px 0$/],
        "line-height": [/^1\.6$/],
        "padding-left": [/^22px$/],
      },
    },
    allowedAttributes: {
      ...Object.fromEntries(EMAIL_BODY_TAGS.map((tag) => [tag, ["style"]])),
    },
    transformTags,
  }).trim();
}

/**
 * Lossless upgrade of a legacy PLAIN body for the rich editor: blank-line
 * blocks become paragraphs, inner newlines become `<br>`. Used when an admin
 * opens an override saved before the feature; nothing is stored until they
 * save.
 */
export function plainTextToEmailBodyHtml(bodyText: string): string {
  const blocks = bodyText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
