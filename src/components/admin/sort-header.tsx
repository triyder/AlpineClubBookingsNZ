import * as React from "react"
import Link from "next/link"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { TableHead } from "@/components/ui/table"

export type SortDirection = "asc" | "desc"

export interface SortIconProps {
  /** Whether this column is the active sort column. */
  active: boolean
  /** Current sort direction (only meaningful when active). */
  direction: SortDirection
  className?: string
}

/**
 * The three-state sort affordance shared by every admin list header: a faint
 * up/down glyph when inactive, and a solid up or down arrow when this column is
 * the active sort. Marked aria-hidden — the sort state is conveyed to assistive
 * tech via `aria-sort` on the surrounding <th> (see SortHeader).
 */
export function SortIcon({ active, direction, className }: SortIconProps) {
  const base = cn("ml-1 h-3 w-3", className)
  if (!active) {
    return <ArrowUpDown aria-hidden className={cn(base, "opacity-40")} />
  }
  return direction === "asc" ? (
    <ArrowUp aria-hidden className={base} />
  ) : (
    <ArrowDown aria-hidden className={base} />
  )
}

export interface SortHeaderProps {
  /** Header label. */
  children: React.ReactNode
  /** Whether this column is the active sort column. */
  active: boolean
  /** Current sort direction (only meaningful when active). */
  direction: SortDirection
  /**
   * URL mode: a precomputed href that toggles/sets the sort for this column.
   * Renders a Next.js <Link>, so a Server Component can use it (pass the
   * already-built string; do not pass a function across the RSC boundary).
   */
  href?: string
  /**
   * Callback mode: called when the header is activated. Renders a <button>.
   * Ignored when `href` is provided.
   */
  onSort?: () => void
  /** Text alignment of the header cell. Defaults to "left". */
  align?: "left" | "right" | "center"
  /** Extra classes for the <th> (TableHead). */
  className?: string
  /** Accessible label for the control when the visible text is not enough. */
  "aria-label"?: string
}

/**
 * One sortable table header for every admin list. Renders a shadcn `TableHead`
 * that exposes the sort state via `aria-sort`, with an inner control that is a
 * `<Link>` in URL mode (`href`) or a `<button>` in callback mode (`onSort`).
 * This is a shared (non-client) component: URL-driven server pages pass a
 * precomputed `href`; client pages pass an `onSort` handler.
 */
export function SortHeader({
  children,
  active,
  direction,
  href,
  onSort,
  align = "left",
  className,
  "aria-label": ariaLabel,
}: SortHeaderProps) {
  const ariaSort: React.AriaAttributes["aria-sort"] = active
    ? direction === "asc"
      ? "ascending"
      : "descending"
    : "none"

  const alignClass =
    align === "right"
      ? "text-right"
      : align === "center"
        ? "text-center"
        : "text-left"

  const controlClass = cn(
    "inline-flex items-center whitespace-nowrap rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    align === "right" && "flex-row-reverse",
  )

  const inner =
    href !== undefined ? (
      <Link href={href} aria-label={ariaLabel} className={controlClass}>
        {children}
        <SortIcon active={active} direction={direction} />
      </Link>
    ) : (
      <button
        type="button"
        onClick={onSort}
        aria-label={ariaLabel}
        className={controlClass}
      >
        {children}
        <SortIcon active={active} direction={direction} />
      </button>
    )

  return (
    <TableHead aria-sort={ariaSort} className={cn("select-none", alignClass, className)}>
      {inner}
    </TableHead>
  )
}
