"use client";

import { useCallback } from "react";
import { matchHelpEntry } from "@/lib/help/match";
import { memberFallbackHelp, memberHelpEntries } from "@/lib/help/member-help";
import type { HelpPageContent } from "@/lib/help/types";
import { HelpWidget } from "./help-widget";

/**
 * Member-surface help widget. Imports ONLY the member corpus resolver (via the
 * type-only `match` matcher), so the authenticated bundle carries no public
 * corpus and resolves member pages entirely client-side.
 */
export function HelpWidgetMember({
  llmEnabled,
  chatEndpoint,
}: {
  llmEnabled: boolean;
  chatEndpoint?: string;
}) {
  const resolveHelp = useCallback(
    (pathname: string): HelpPageContent =>
      matchHelpEntry(pathname, memberHelpEntries, memberFallbackHelp),
    [],
  );

  return (
    <HelpWidget
      surface="member"
      llmEnabled={llmEnabled}
      resolveHelp={resolveHelp}
      position="app"
      chatEndpoint={chatEndpoint}
    />
  );
}
