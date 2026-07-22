"use client";

import {
  HelpContentBody,
  SectionHelpList,
} from "@/components/help-content-body";
import type { HelpSection } from "@/lib/contextual-help";
import type { HelpPageContent } from "@/lib/help/types";

/**
 * The "Page guide" view: the full templated page help (the same content the
 * retired ContextualHelpButton dialog rendered) followed by any page-registered
 * extra sections (e.g. the booking-detail glossary / refund schedule).
 */
export function HelpBrowseView({
  content,
  extraSections,
}: {
  content: HelpPageContent;
  extraSections: HelpSection[];
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-foreground">
          {content.title}
        </h3>
        <p className="text-sm leading-6 text-muted-foreground">
          {content.summary}
        </p>
      </div>
      <HelpContentBody help={content} />
      <SectionHelpList title="On this page" sections={extraSections} />
    </div>
  );
}
