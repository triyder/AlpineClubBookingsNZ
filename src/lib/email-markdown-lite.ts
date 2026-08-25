/**
 * Markdown-lite for admin-editable email bodies (fork #38).
 *
 * A deliberately TINY vocabulary — `**bold**`, `*italic*`, `# heading` /
 * `## subheading` at line start, and `- ` bullet lines — mapped onto inline
 * HTML in the themed email shell. FLAT, not nested: bold cannot contain
 * italic (the inner pair renders and the outer markers stay literal), and
 * Preview shows exactly that. Nothing else: no link syntax (the body
 * already carries URLs as text), no images, and no raw HTML, because every
 * transform here runs on text that has ALREADY been HTML-escaped — an angle
 * bracket typed into a body renders as a literal angle bracket, exactly as
 * before this feature.
 *
 * The transforms run AFTER token substitution and AFTER escaping, in that
 * order, so no token value can smuggle markup. A system-composed token value
 * that happened to contain a matched `**pair**` would render bold — no
 * composer emits one (they are label-and-value lines), and the trade is
 * documented in the guide.
 *
 * Storage stays plain text. Whether a body renders through these transforms
 * at all is the per-override `bodyMarkdown` flag: rows saved before the
 * feature keep the flag false and render byte-for-byte as before, so a legacy
 * body containing a literal `*` or `#` is never silently reinterpreted.
 */

export type MarkdownLiteLine =
  | { kind: "heading"; level: 2 | 3; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "text"; text: string };

/**
 * Inline transforms over one line of HTML-ESCAPED text: `**bold**` then
 * `*italic*`. Bold consumes first so a doubled marker can never be read as
 * two italics. The wrapped content must start AND end on a non-space, so
 * free-standing asterisks in prose or arithmetic ("2 * 3", "4 ** 2") are
 * never joined into one accidental span; an unmatched or empty marker stays
 * a literal asterisk.
 */
export function applyInlineMarkdownLite(escapedLine: string): string {
  // Content endpoints exclude both whitespace AND asterisks, so a bare run of
  // markers ("****") can never read one of its own markers as content.
  return escapedLine
    .replace(/\*\*([^\s*](?:[^*\n]*[^\s*])?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, "<em>$1</em>");
}

/**
 * Classify one raw (still-escaped) line of a body block. `#`/`##` and `- `
 * bind only at the very start of a line — a mid-line hash or dash (a money
 * value, a phone number, "check-in - check-out") is ordinary text.
 */
export function classifyMarkdownLiteLine(line: string): MarkdownLiteLine {
  const h2 = line.match(/^# (.+)$/);
  if (h2) return { kind: "heading", level: 2, text: h2[1] };
  const h3 = line.match(/^## (.+)$/);
  if (h3) return { kind: "heading", level: 3, text: h3[1] };
  const bullet = line.match(/^- (.+)$/);
  if (bullet) return { kind: "bullet", text: bullet[1] };
  return { kind: "text", text: line };
}

/**
 * True when a body contains no markdown-lite syntax at all, in which case the
 * formatted renderer produces the same shape as the plain renderer. Exposed
 * for the compatibility property test, not for control flow.
 */
export function containsMarkdownLiteSyntax(bodyText: string): boolean {
  return (
    /\*\*[^*\n]+\*\*|\*[^*\n]+\*/.test(bodyText) ||
    /^#{1,2} .+$/m.test(bodyText) ||
    /^- .+$/m.test(bodyText)
  );
}
