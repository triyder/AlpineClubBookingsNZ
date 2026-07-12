"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SectionNavItem {
  /** The id of the section element this link jumps to. */
  id: string;
  /** Visible link text. */
  label: string;
}

/**
 * SectionNav — an anchor rail for long member pages (epic #1800, issue #1818).
 *
 * PRESENTATION ONLY / additive navigation. It renders in-page anchor links to
 * sections that already exist on the page; it never adds, removes, or reorders
 * page content. Candidates whose target id is absent from the DOM (the booking
 * page renders most cards conditionally) are pruned after mount so the rail
 * never offers a dead link — this avoids duplicating the page's server-side
 * render conditions here.
 *
 * Desktop: a sticky vertical rail beside the content. Mobile: a native
 * `<details>` disclosure (accordion) above the content, matching the existing
 * profile section-card pattern — no extra JS, SSR-safe, and keyboard-operable.
 * Anchor links are natively focusable; smooth-scroll (if any) is collapsed by
 * the global `prefers-reduced-motion` guard (#1801).
 */
export function SectionNav({
  sections,
  title = "On this page",
  className,
}: {
  sections: SectionNavItem[];
  title?: string;
  className?: string;
}) {
  // Stable dependency: the candidate ids, joined. The page passes a literal
  // array so this only changes if the section set genuinely changes.
  const idKey = sections.map((section) => section.id).join(",");

  // `null` until we have measured the DOM. During SSR and the first client
  // render we show every candidate (so markup matches and nothing flashes
  // missing); after mount we prune to the sections actually present.
  const [presentIds, setPresentIds] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const present = idKey
      .split(",")
      .filter((id) => id.length > 0 && document.getElementById(id));
    setPresentIds(present);
  }, [idKey]);

  const visible =
    presentIds === null
      ? sections
      : sections.filter((section) => presentIds.includes(section.id));

  // A one-item rail is noise on a long page; only show real navigation.
  if (visible.length < 2) return null;

  const links = (
    <ul className="space-y-0.5">
      {visible.map((section) => (
        <li key={section.id}>
          <a
            href={`#${section.id}`}
            className="block rounded-md px-3 py-1.5 text-sm text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {section.label}
          </a>
        </li>
      ))}
    </ul>
  );

  return (
    <nav aria-label={title} className={cn("lg:w-56 lg:shrink-0", className)}>
      {/* Mobile: collapsible disclosure above the content. */}
      <details className="group rounded-lg border bg-card lg:hidden [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
          {title}
          <ChevronDown
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="px-1 pb-2">{links}</div>
      </details>

      {/* Desktop: sticky rail beside the content. */}
      <div className="sticky top-20 hidden lg:block">
        <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
        {links}
      </div>
    </nav>
  );
}
