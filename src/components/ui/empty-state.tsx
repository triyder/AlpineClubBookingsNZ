import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  /** Optional lucide icon rendered above the heading (decorative). */
  icon?: LucideIcon;
  /** Short heading naming what is empty. */
  title: React.ReactNode;
  /** One line of direction: what to do next, phrased as an invitation. */
  description?: React.ReactNode;
  /** Optional action slot (button or link) to start the suggested next step. */
  action?: React.ReactNode;
  /**
   * Heading level so the state fits the surrounding page outline. Defaults to 2
   * (all current adoption sites carry a single page `<h1>`).
   */
  headingLevel?: 2 | 3 | 4;
}

/**
 * Restrained, theme-aware empty state: an icon, a heading, one line of
 * direction, and an optional action. Reads as an invitation to act rather than
 * a dead end. Colours come from semantic tokens so it adapts to light/dark.
 */
function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  headingLevel = 2,
  className,
  ...props
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
      {...props}
    >
      {Icon ? (
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon aria-hidden="true" className="h-6 w-6" />
        </span>
      ) : null}
      <div className="space-y-1">
        <Heading className="text-sm font-medium text-foreground">{title}</Heading>
        {description ? (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export { EmptyState };
