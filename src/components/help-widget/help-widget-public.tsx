"use client";

import { useCallback } from "react";
import { matchHelpEntry } from "@/lib/help/match";
import { publicFallbackHelp, publicHelpEntries } from "@/lib/help/public-help";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpWidget } from "./help-widget";

/**
 * Public (signed-out website) help widget. Imports ONLY the public corpus, which
 * itself imports nothing but local types — so the public client bundle carries
 * NO admin/member corpus. `llmEnabled` is hardcoded false: the public surface
 * never gets the free-text path (the LLM ships to members only, in C4).
 */
export function HelpWidgetPublic() {
  const resolveHelp = useCallback(
    (pathname: string): HelpPageContent =>
      matchHelpEntry(pathname, publicHelpEntries, publicFallbackHelp),
    [],
  );

  return (
    <HelpWidget
      surface="public"
      llmEnabled={false}
      resolveHelp={resolveHelp}
      position="website"
    />
  );
}
