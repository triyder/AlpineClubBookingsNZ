/**
 * The shell and the blocks every club email is built from.
 *
 * Shared DELIBERATELY (#2689): one `layout()` and one set of blocks, imported
 * by every message-family module, rather than each family carrying its own
 * copy. Email clients apply inline CSS in source order, so a second copy that
 * drifted by one declaration would show as a different email while reading as
 * the same code.
 *
 * Brand colours come per-render from the club (Site Style) theme via
 * `emailPalette()` (see email-theme.ts), so emails match the live site. Each
 * helper reads `const p = emailPalette()` once and uses p.gold, p.charcoal,
 * p.deep, p.mist, p.snow, p.ridge. `WHITE` and the logo URL are not brand roles
 * and stay fixed.
 */
import { escapeHtml } from "./escape";
import { CLUB_NAME } from "@/config/club-identity";
import { getAppBaseUrl, sanitizeEmailHref } from "@/lib/app-url";
import {
  applyInlineMarkdownLite,
  classifyMarkdownLiteLine,
} from "@/lib/email-markdown-lite";
import { EMAIL_DEFAULT_FROM_NAME } from "@/lib/email-message-settings";
import { SUPPORT_EMAIL } from "@/lib/email-sender";
import { emailPalette } from "@/lib/email-theme";
import { formatCents as formatMoneyCents } from "@/lib/utils";

export const BASE_URL = getAppBaseUrl();

const BRAND_LOGO_URL = `${BASE_URL}/branding/logo.png`;

export const WHITE = "#ffffff";

export function layout(content: string): string {
  const p = emailPalette();
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(EMAIL_DEFAULT_FROM_NAME)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: ${p.snow}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${p.snow};">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <!-- Header -->
          <tr>
            <td style="background-color: ${p.charcoal}; padding: 28px 32px 24px; border-top: 4px solid ${p.gold}; border-radius: 8px 8px 0 0; text-align: center;">
              <img
                src="${BRAND_LOGO_URL}"
                alt="${escapeHtml(CLUB_NAME)}"
                width="176"
                style="display: block; margin: 0 auto 14px; width: 176px; max-width: 100%; height: auto;"
              />
              <p style="margin: 0; color: ${WHITE}; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;">
                Online Booking System
              </p>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 32px; border-left: 1px solid ${p.mist}; border-right: 1px solid ${p.mist};">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: ${WHITE}; padding: 20px 32px; border-top: 1px solid ${p.mist}; border-radius: 0 0 8px 8px; border-left: 1px solid ${p.mist}; border-right: 1px solid ${p.mist}; border-bottom: 1px solid ${p.mist};">
              <p style="margin: 0; color: ${p.ridge}; font-size: 12px; text-align: center;">
                ${escapeHtml(CLUB_NAME)} &bull; Online Booking System<br>
                <a href="${BASE_URL}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: none;">${BASE_URL.replace(/^https?:\/\//, "")}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export function supportEmailLink(): string {
  const p = emailPalette();
  const address = escapeHtml(SUPPORT_EMAIL);
  return `<a href="mailto:${address}" style="color: ${p.charcoal}; font-weight: 600; text-decoration: none;">${address}</a>`;
}

export function supportContactMuted(): string {
  return muted(`${escapeHtml(CLUB_NAME)} — ${supportEmailLink()}`);
}

export function supportContactSentence(prefix: string): string {
  return muted(`${prefix}${supportEmailLink()}.`);
}

export function button(
  text: string,
  url: string,
  options?: { sameOrigin?: boolean }
): string {
  const p = emailPalette();
  const safeUrl = sanitizeEmailHref(url, {
    baseUrl: BASE_URL,
    sameOrigin: options?.sameOrigin,
  });

  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
  <tr>
    <td style="background-color: ${p.gold}; border-radius: 6px;">
      <a href="${escapeHtml(safeUrl)}" target="_blank" style="display: inline-block; padding: 12px 28px; color: ${p.charcoal}; text-decoration: none; font-weight: 700; font-size: 14px;">
        ${text}
      </a>
    </td>
  </tr>
</table>`;
}

export function infoTable(rows: Array<{ label: string; value: string }>): string {
  const p = emailPalette();
  const rowsHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding: 8px 12px; font-weight: 600; color: ${p.deep}; font-size: 14px; border-bottom: 1px solid ${p.mist}; white-space: nowrap;">${r.label}</td>
      <td style="padding: 8px 12px; color: ${p.deep}; font-size: 14px; border-bottom: 1px solid ${p.mist};">${r.value}</td>
    </tr>`
    )
    .join("");

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border: 1px solid ${p.mist}; border-radius: 6px; border-collapse: collapse; margin: 16px 0;">
  ${rowsHtml}
</table>`;
}

export function heading(text: string): string {
  const p = emailPalette();
  return `<h2 style="margin: 0 0 16px 0; color: ${p.deep}; font-size: 22px; font-weight: 700;">${text}</h2>`;
}

export function paragraph(text: string): string {
  const p = emailPalette();
  return `<p style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 15px; line-height: 1.6;">${text}</p>`;
}

export function plainTextEmailTemplate(bodyText: string): string {
  const blocks = bodyText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const [firstBlock, ...rest] = blocks;
  const headingHtml = firstBlock ? heading(escapeHtml(firstBlock)) : "";
  const bodyHtml = rest.length > 0
    ? rest
        .map((block) => multilineBlock(escapeHtml(block)))
        .join("")
    : "";

  return layout(`
    ${headingHtml}
    ${bodyHtml}
  `);
}

export function multilineBlock(text: string): string {
  const p = emailPalette();
  return `<div style="margin: 0 0 12px 0; color: ${p.deep}; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">${text}</div>`;
}

/**
 * The markdown-lite twin of `plainTextEmailTemplate` (fork #38): same shell,
 * same first-block-becomes-the-heading convention, but body blocks pass
 * through the tiny formatting vocabulary — `**bold**`, `*italic*`,
 * `# `/`## ` section headings and `- ` bullets. Selected per override by the
 * stored `bodyMarkdown` flag; a body containing NO syntax renders the exact
 * shape `plainTextEmailTemplate` produces, which is what keeps a re-saved
 * unformatted body visually unchanged. Kept in this module deliberately —
 * one layout, one set of blocks (#2689) — with the pure line/inline
 * transforms in @/lib/email-markdown-lite for testing without the shell.
 */
export function markdownLiteEmailTemplate(bodyText: string): string {
  const blocks = bodyText
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  const [firstBlock, ...rest] = blocks;
  const headingHtml = firstBlock ? heading(escapeHtml(firstBlock)) : "";
  const bodyHtml = rest.length > 0
    ? rest.map((block) => markdownLiteBlock(block)).join("")
    : "";

  return layout(`
    ${headingHtml}
    ${bodyHtml}
  `);
}

function markdownLiteSectionHeading(level: 2 | 3, html: string): string {
  const p = emailPalette();
  return level === 2
    ? `<h2 style="margin: 20px 0 10px 0; color: ${p.charcoal}; font-size: 19px; font-weight: 700; line-height: 1.3;">${html}</h2>`
    : `<h3 style="margin: 16px 0 8px 0; color: ${p.charcoal}; font-size: 16px; font-weight: 700; line-height: 1.3;">${html}</h3>`;
}

function markdownLiteBlock(block: string): string {
  const p = emailPalette();
  // Classification runs on ESCAPED lines; escaping touches none of the
  // marker characters, and per-line escaping joined with \n is byte-equal to
  // escaping the whole block, which is what makes the no-syntax fast path
  // identical to `multilineBlock(escapeHtml(block))`.
  const lines = block
    .split("\n")
    .map((line) => classifyMarkdownLiteLine(escapeHtml(line)));

  const segments: string[] = [];
  let textRun: string[] = [];
  let bullets: string[] = [];
  const flushText = () => {
    if (textRun.length > 0) {
      segments.push(
        multilineBlock(textRun.map(applyInlineMarkdownLite).join("\n")),
      );
      textRun = [];
    }
  };
  const flushBullets = () => {
    if (bullets.length > 0) {
      const items = bullets
        .map(
          (item) =>
            `<li style="margin: 0 0 4px 0;">${applyInlineMarkdownLite(item)}</li>`,
        )
        .join("");
      segments.push(
        `<ul style="margin: 0 0 12px 0; padding-left: 22px; color: ${p.deep}; font-size: 15px; line-height: 1.6;">${items}</ul>`,
      );
      bullets = [];
    }
  };

  for (const line of lines) {
    if (line.kind === "bullet") {
      flushText();
      bullets.push(line.text);
    } else if (line.kind === "heading") {
      flushText();
      flushBullets();
      segments.push(
        markdownLiteSectionHeading(line.level, applyInlineMarkdownLite(line.text)),
      );
    } else {
      flushBullets();
      textRun.push(line.text);
    }
  }
  flushText();
  flushBullets();
  return segments.join("");
}

export function muted(text: string): string {
  const p = emailPalette();
  return `<p style="margin: 0 0 8px 0; color: ${p.ridge}; font-size: 13px; line-height: 1.5;">${text}</p>`;
}

export function alertBox(
  text: string,
  type: "info" | "warning" | "success" = "info"
): string {
  const p = emailPalette();
  const colors = {
    info: { bg: "#fff7d6", border: p.gold, text: p.deep },
    warning: { bg: "#fef3c7", border: "#fcd34d", text: "#92400e" },
    success: { bg: "#dcfce7", border: "#86efac", text: "#166534" },
  };
  const c = colors[type];
  return `
<div style="background-color: ${c.bg}; border: 1px solid ${c.border}; border-radius: 6px; padding: 12px 16px; margin: 16px 0;">
  <p style="margin: 0; color: ${c.text}; font-size: 14px; font-weight: 600; white-space: pre-wrap;">${text}</p>
</div>`;
}

export function formatCents(cents: number): string {
  return formatMoneyCents(cents);
}
