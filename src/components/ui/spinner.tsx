import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const spinnerSizes = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
} as const;

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: keyof typeof spinnerSizes;
  /** Accessible label announced to screen readers (also used as reduced-motion signal). */
  label?: string;
}

/**
 * Themed loading spinner. Inherits its colour from `currentColor` (defaults to
 * the muted foreground token) so it adapts to light/dark themes.
 *
 * Accessibility: the wrapper is a live `role="status"` region carrying a
 * visually-hidden label, and the icon is `aria-hidden`. The global
 * `prefers-reduced-motion: reduce` guard (#1801) freezes `animate-spin`, so for
 * reduced-motion and screen-reader users the icon still shows as a static
 * indicator while the status text conveys the loading state.
 */
function Spinner({
  size = "md",
  label = "Loading…",
  className,
  ...props
}: SpinnerProps) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center justify-center text-muted-foreground",
        className,
      )}
      {...props}
    >
      <Loader2 aria-hidden="true" className={cn("animate-spin", spinnerSizes[size])} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export { Spinner };
