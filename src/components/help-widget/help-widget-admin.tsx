"use client";

import { useCallback } from "react";
import { getContextualHelp } from "@/lib/contextual-help";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpWidget } from "./help-widget";

/**
 * Admin / finance help widget. Resolves against the existing
 * `@/lib/contextual-help` registry (the admin+finance corpus) — the ONLY corpus
 * this wrapper imports, so it pulls neither the member nor the public corpus.
 */
export function HelpWidgetAdmin({
  scope,
  llmEnabled,
  chatEndpoint,
}: {
  scope: "admin" | "finance";
  llmEnabled: boolean;
  chatEndpoint?: string;
}) {
  const resolveHelp = useCallback(
    (pathname: string): HelpPageContent => getContextualHelp(pathname, scope),
    [scope],
  );

  return (
    <HelpWidget
      surface={scope}
      llmEnabled={llmEnabled}
      resolveHelp={resolveHelp}
      position="app"
      chatEndpoint={chatEndpoint}
    />
  );
}
