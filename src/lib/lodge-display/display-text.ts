import type { DisplayState } from "../lodge-display-state";

// Token resolution for display-authored copy (fork issue #31; value-token
// resolution inside authored HTML added in LTV-028, ADR-003 §4).
//
// The grammar is the display's OWN token set — deliberately NOT the site-wide
// token catalogue (src/lib/token-catalogue.ts), which resolves on the public
// website outside the display auth boundary. A wall must never surface a site
// token that reveals data beyond the privacy-reduced DisplayState payload, so
// PLACEHOLDER_PATTERN matches ONLY these value tokens:
//   {{config:<key>}}  {{lodge-name}}  {{display-date}}
// Any other `{{…}}` (a site token like {{club-name}}, or a `{{module:<name>}}`
// embed handled by the layout splitter) is not matched here and is therefore
// left VERBATIM — the token-scope security line lives in this closed regex.
//
// Two resolvers share that one grammar:
//   • resolveDisplayText — returns plain TEXT for React text nodes. Consumers
//     render it as children (never dangerouslySetInnerHTML), so HTML escaping
//     is React's job and a config value can never inject markup.
//   • resolveDisplayHtml — returns HTML for an authored html surface, with each
//     injected value HTML-escaped (and its braces neutralised) on injection, so
//     a config value renders as inert TEXT even inside html and can never inject
//     markup nor form a second `{{…}}` token.
//
// EXTENSION POINT (ADR-003 §4, deferred): module-contributed VALUE tokens would
// slot in here as a second alternative in PLACEHOLDER_PATTERN plus a branch in
// resolveToken — one grammar, still closed to the display's own token set. Not
// built in v1 (see #74 "Do NOT build").

const PLACEHOLDER_PATTERN = /\{\{\s*(config:([a-z0-9][a-z0-9-]{0,63})|lodge-name|display-date)\s*\}\}/gi;

/** Resolve one matched value token to its raw (unescaped) replacement string. */
function resolveToken(
  token: string,
  configKey: string | undefined,
  state: DisplayState
): string {
  const lower = token.toLowerCase();
  if (lower === "lodge-name") return state.lodge.name;
  if (lower === "display-date") {
    const day = new Date(`${state.window.start}T00:00:00`);
    return day.toLocaleDateString("en-NZ", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  }
  // configKey is always set for the remaining `config:<key>` alternative.
  const value = state.config[configKey!.toLowerCase()];
  // An unset key renders a VISIBLE placeholder so misconfiguration is obvious
  // on the screen during setup, never silently blank (brief §3).
  return value ?? `⟨config:${configKey!.toLowerCase()}?⟩`;
}

/**
 * Resolve the display's value tokens to plain TEXT (for React text nodes).
 * Non-display tokens (site catalogue tokens, module embeds) are left verbatim.
 */
export function resolveDisplayText(template: string, state: DisplayState): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (_whole, token: string, configKey?: string) =>
      resolveToken(token, configKey, state)
  );
}

/**
 * HTML-escape a resolved value for injection into an authored html surface.
 * Escapes the five HTML-significant characters so the value renders as literal
 * text, AND neutralises `{`/`}` so an injected value can never form a second
 * `{{…}}` token (config/area/module) that a later splitter would act on — the
 * value is inert text, full stop.
 */
function escapeHtmlValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

/**
 * Resolve the display's value tokens inside an authored html surface, with each
 * injected value HTML-escaped. The template's own markup and any non-display
 * `{{…}}` token (site catalogue tokens, `{{module:<name>}}` embeds) are left
 * untouched — only the closed value-token set is substituted, and only the
 * substituted value is escaped. Run this AFTER the CMS sanitiser (see
 * layout-render.ts): the sanitiser trusts the authored template, and escaping
 * the injected value is what keeps a config value from being markup.
 */
export function resolveDisplayHtml(template: string, state: DisplayState): string {
  return template.replace(
    PLACEHOLDER_PATTERN,
    (_whole, token: string, configKey?: string) =>
      escapeHtmlValue(resolveToken(token, configKey, state))
  );
}
