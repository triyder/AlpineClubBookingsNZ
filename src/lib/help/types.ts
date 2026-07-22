import type { ContextualHelpContent, HelpQuestion } from "@/lib/contextual-help";

/**
 * The four help surfaces the unified corpus serves. Admin and finance reuse the
 * existing `@/lib/contextual-help` registries; member and public are new corpora
 * in this folder. There is no import cycle: this module only imports *types* from
 * `contextual-help.ts`, and `contextual-help.ts` never imports from here.
 */
export type HelpSurface = "public" | "member" | "admin" | "finance";

// Re-export so callers can `import { HelpQuestion } from "@/lib/help/types"`.
// The concrete shape is owned by contextual-help.ts to keep it cycle-free.
export type { HelpQuestion } from "@/lib/contextual-help";

/**
 * Page help content plus the plain-English Q&A distilled for that page. This is
 * structurally identical to `ContextualHelpContent` (which already carries an
 * optional `questions`), but the explicit intersection documents intent and
 * keeps the member/public corpora honest about always thinking in Q&A terms.
 */
export type HelpPageContent = ContextualHelpContent & {
  questions?: HelpQuestion[];
};

/**
 * A single corpus entry. `path` uses the existing longest-prefix match semantics
 * (an entry at `/bookings` also matches `/bookings/123`), PLUS a `"/x/*"` suffix
 * form that matches `/x/<anything>` but NOT `/x` itself — used to distinguish a
 * list page (`/bookings`) from a detail page (`/bookings/[id]`). The `/*` matcher
 * lives in `@/lib/help` (`getHelpForPage`).
 */
export type HelpPageEntry = {
  path: string;
  content: HelpPageContent;
};
