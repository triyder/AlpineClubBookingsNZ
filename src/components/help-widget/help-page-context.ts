import type { HelpWidgetExtras } from "./help-widget-context";

/**
 * Serialize the widget's registered page extras (sections + curated questions)
 * into a compact plain-text block for the `pageContext` field of a /api/help/chat
 * POST. This is UNTRUSTED client-supplied context: the route wraps and labels it
 * as such and never mixes it into the trusted grounding — it only gives the model
 * a hint about the page state the member is looking at (e.g. the booking-detail
 * refund schedule).
 *
 * Capped to 3800 chars so it stays comfortably under the route's zod max of 4000
 * even after the (already length-bounded) surrounding wrapper.
 */
export const PAGE_CONTEXT_MAX_CHARS = 3800;

export function serializePageContext(
  extras: HelpWidgetExtras,
): string | undefined {
  const parts: string[] = [];

  for (const section of extras.sections ?? []) {
    parts.push(section.title);
    for (const detail of section.details ?? []) {
      parts.push(`- ${detail}`);
    }
  }

  for (const question of extras.questions ?? []) {
    parts.push(`Q: ${question.q}`);
    parts.push(`A: ${question.a}`);
  }

  const text = parts.join("\n").trim();
  if (!text) return undefined;
  return text.length > PAGE_CONTEXT_MAX_CHARS
    ? text.slice(0, PAGE_CONTEXT_MAX_CHARS)
    : text;
}
