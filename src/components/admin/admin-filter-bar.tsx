"use client"

import * as React from "react"
import { ChevronDown, X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * One active filter, shown as a removable chip. `label` is the human filter
 * name (e.g. "Status"), `value` its current display value (e.g. "Paid"); the
 * chip renders "{label}: {value}" with an × that clears just this filter.
 */
export interface AdminFilterChip {
  /** Stable key (usually the filter's URL/query param name). */
  key: string
  /** Human filter name, e.g. "Status". */
  label: string
  /** Current value display, e.g. "Paid". */
  value: string
  /** Clear just this one filter. */
  onRemove: () => void
}

export interface AdminFilterBarProps {
  /**
   * Search field node. Rendered first in the primary row and allowed to grow /
   * stack full-width on mobile.
   */
  search?: React.ReactNode
  /** Always-visible primary filter controls (the 3–4 most-used filters). */
  primary?: React.ReactNode
  /** Long-tail controls revealed by the "More filters" disclosure. */
  advanced?: React.ReactNode
  /**
   * Count of currently-active advanced filters. Shown as a badge on the
   * collapsed "More filters" trigger, and (unless `defaultAdvancedOpen` is set)
   * auto-opens the disclosure on mount when > 0 so a shared link that pins an
   * advanced filter lands with it visible.
   */
  advancedActiveCount?: number
  /** Force the disclosure's initial open state. Defaults to advancedActiveCount > 0. */
  defaultAdvancedOpen?: boolean
  /** Active-filter chips (label + value + remove). */
  chips?: AdminFilterChip[]
  /** Right-aligned actions in the primary row (e.g. a Clear button). */
  actions?: React.ReactNode
  /** Label for the disclosure trigger. Defaults to "More filters". */
  moreFiltersLabel?: string
  /** Stable id prefix for the disclosure aria wiring. */
  idPrefix?: string
  /** Extra classes for the outer container. */
  className?: string
}

/**
 * The shared "Restrained Alpine" admin filter-bar shell (epic #1800).
 *
 * A presentational layout only — it owns no filter state and drives no URL. It
 * arranges caller-supplied controls into three calm rows: a primary row (search
 * + the most-used filters, always visible), a collapsible "More filters"
 * disclosure for the long tail (keyboard-accessible via `aria-expanded` /
 * `aria-controls`, with a count badge of active advanced filters while
 * collapsed), and a row of removable active-filter chips. Everything is themed
 * with semantic tokens so it honours dark mode and the club theme, and the rows
 * wrap so the bar stays usable on mobile.
 */
export function AdminFilterBar({
  search,
  primary,
  advanced,
  advancedActiveCount = 0,
  defaultAdvancedOpen,
  chips,
  actions,
  moreFiltersLabel = "More filters",
  idPrefix = "admin-filter-bar",
  className,
}: AdminFilterBarProps) {
  const [advancedOpen, setAdvancedOpen] = React.useState(
    defaultAdvancedOpen ?? advancedActiveCount > 0,
  )
  const hasAdvanced = advanced != null && advanced !== false
  const regionId = `${idPrefix}-advanced`
  const showBadge = !advancedOpen && advancedActiveCount > 0

  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground",
        className,
      )}
    >
      <div className="flex flex-wrap items-end gap-3">
        {search != null ? (
          <div className="min-w-[12rem] basis-full sm:flex-1 sm:basis-64">
            {search}
          </div>
        ) : null}
        {primary}
        {hasAdvanced ? (
          <button
            type="button"
            aria-expanded={advancedOpen}
            aria-controls={regionId}
            onClick={() => setAdvancedOpen((open) => !open)}
            className="inline-flex h-9 items-center gap-1.5 self-end rounded-md border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span>{moreFiltersLabel}</span>
            {showBadge ? (
              <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                {advancedActiveCount}
              </span>
            ) : null}
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 shrink-0 transition-transform",
                advancedOpen && "rotate-180",
              )}
            />
          </button>
        ) : null}
        {actions != null ? (
          <div className="ml-auto flex items-end gap-2">{actions}</div>
        ) : null}
      </div>

      {hasAdvanced && advancedOpen ? (
        <div
          id={regionId}
          className="flex flex-wrap items-end gap-3 border-t border-border pt-3"
        >
          {advanced}
        </div>
      ) : null}

      {chips && chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={chip.onRemove}
              aria-label={`Remove ${chip.label} filter`}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted px-2 py-0.5 text-xs font-medium text-foreground transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate">
                {chip.label}: {chip.value}
              </span>
              <X aria-hidden="true" className="size-3 shrink-0" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
