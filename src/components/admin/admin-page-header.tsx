import * as React from "react"

import { cn } from "@/lib/utils"

export interface AdminPageHeaderProps {
  /** Page title. Rendered as the single <h1> (League Spartan via .app-theme-scope). */
  title: React.ReactNode
  /** Small uppercase label above the title (e.g. a section name). */
  eyebrow?: React.ReactNode
  /** Supporting line under the title. */
  description?: React.ReactNode
  /** Right-aligned action slot (primary buttons, links). */
  actions?: React.ReactNode
  /** Extra classes for the outer wrapper. */
  className?: string
}

/**
 * The one admin page-title pattern for the "Restrained Alpine" admin shell.
 *
 * Renders an optional eyebrow, a single <h1>, an optional description, and a
 * right-aligned actions slot. Colours use semantic tokens so the header honours
 * dark mode and the club theme. This is a shared (non-client) component so it
 * can render inside either server or client admin pages.
 */
export function AdminPageHeader({
  title,
  eyebrow,
  description,
  actions,
  className,
}: AdminPageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        {eyebrow ? (
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
