"use client"

import * as React from "react"
import { Rows2, Rows3 } from "lucide-react"

import { cn } from "@/lib/utils"

export type AdminDataTableDensity = "comfortable" | "compact"

const DEFAULT_STORAGE_KEY = "admin:data-table-density"

const AdminDataTableDensityContext =
  React.createContext<AdminDataTableDensity>("comfortable")

/**
 * Read the current density from inside an {@link AdminDataTable}. Cells that
 * need to do more than adjust padding (which the table already handles) can
 * branch on this. Returns "comfortable" outside a table.
 */
export function useAdminDataTableDensity(): AdminDataTableDensity {
  return React.useContext(AdminDataTableDensityContext)
}

function isDensity(value: unknown): value is AdminDataTableDensity {
  return value === "comfortable" || value === "compact"
}

// Density drives cell padding via descendant selectors on the scroll container.
// An arbitrary variant like `[&_td]:px-3` compiles to `.cls td { … }` whose
// (class + type) specificity beats the shadcn cell's own single-class padding,
// so plain <TableHead>/<TableCell> children respond without any per-cell wiring.
const DENSITY_CELL_CLASSES: Record<AdminDataTableDensity, string> = {
  comfortable:
    "[&_th]:h-11 [&_th]:px-3 [&_th]:py-3 [&_td]:px-3 [&_td]:py-3",
  compact: "[&_th]:h-9 [&_th]:px-2 [&_th]:py-1.5 [&_td]:px-2 [&_td]:py-1.5",
}

export interface AdminDataTableProps {
  /** The table body content — typically shadcn <TableHeader> + <TableBody>. */
  children: React.ReactNode
  /** Sticky column headers while the body scrolls. Defaults to true. */
  stickyHeader?: boolean
  /** Freeze the first column while the body scrolls horizontally. Defaults to false. */
  stickyFirstColumn?: boolean
  /** Show the comfortable/compact density toggle. Defaults to true. */
  showDensityToggle?: boolean
  /** Controlled density. When set, the internal state and localStorage are bypassed. */
  density?: AdminDataTableDensity
  /** Initial density for the uncontrolled case. Defaults to "comfortable". */
  defaultDensity?: AdminDataTableDensity
  /** Notified whenever the density changes (both controlled and uncontrolled). */
  onDensityChange?: (density: AdminDataTableDensity) => void
  /** localStorage key for persisting the uncontrolled density. */
  densityStorageKey?: string
  /** Left-aligned toolbar content (filters summary, bulk actions, caption). */
  toolbar?: React.ReactNode
  /** Bounds the scroll container so the sticky header has something to stick to. */
  maxHeight?: number | string
  /** Extra classes for the <table> element. */
  className?: string
  /** Extra classes for the scroll container. */
  containerClassName?: string
  /** Accessible label for the table. */
  "aria-label"?: string
}

/**
 * The themed shell for admin data tables in the "Restrained Alpine" system.
 *
 * A lightweight wrapper — not a column-config engine — so heterogeneous admin
 * pages keep authoring arbitrary columns and row actions with plain shadcn
 * `TableHeader`/`TableBody` children. It supplies the themed surface (semantic
 * tokens, dark-mode + club-theme aware), a sticky header (and optional sticky
 * first column), and a comfortable/compact density toggle that persists
 * per-user via localStorage. Density is exposed both through cell-padding
 * descendant selectors (so plain cells adjust automatically) and via
 * {@link useAdminDataTableDensity}.
 */
export function AdminDataTable({
  children,
  stickyHeader = true,
  stickyFirstColumn = false,
  showDensityToggle = true,
  density: controlledDensity,
  defaultDensity = "comfortable",
  onDensityChange,
  densityStorageKey = DEFAULT_STORAGE_KEY,
  toolbar,
  maxHeight,
  className,
  containerClassName,
  "aria-label": ariaLabel,
}: AdminDataTableProps) {
  const isControlled = controlledDensity !== undefined
  const [internalDensity, setInternalDensity] =
    React.useState<AdminDataTableDensity>(defaultDensity)

  // SSR-safe persistence: the first client render matches the server (always
  // `defaultDensity`), so there is no hydration mismatch. Only after mount do
  // we reconcile with the per-user localStorage preference.
  React.useEffect(() => {
    if (isControlled) return
    try {
      const stored = window.localStorage.getItem(densityStorageKey)
      if (isDensity(stored)) {
        setInternalDensity((current) => (current === stored ? current : stored))
      }
    } catch {
      // localStorage can throw (private mode, disabled storage); ignore and
      // keep the default.
    }
  }, [isControlled, densityStorageKey])

  const density = isControlled ? controlledDensity : internalDensity

  const setDensity = React.useCallback(
    (next: AdminDataTableDensity) => {
      if (!isControlled) {
        setInternalDensity(next)
        try {
          window.localStorage.setItem(densityStorageKey, next)
        } catch {
          // Ignore storage failures; the in-memory choice still applies.
        }
      }
      onDensityChange?.(next)
    },
    [isControlled, densityStorageKey, onDensityChange],
  )

  const scrollStyle: React.CSSProperties | undefined =
    maxHeight !== undefined ? { maxHeight } : undefined

  return (
    <AdminDataTableDensityContext.Provider value={density}>
      <div className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
        {showDensityToggle || toolbar ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {toolbar}
            </div>
            {showDensityToggle ? (
              <DensityToggle density={density} onChange={setDensity} />
            ) : null}
          </div>
        ) : null}

        <div
          className={cn(
            "relative w-full overflow-auto",
            stickyHeader &&
              "[&_thead_th]:sticky [&_thead_th]:top-0 [&_thead_th]:z-10 [&_thead_th]:bg-card",
            stickyFirstColumn && [
              "[&_tr>:first-child]:sticky [&_tr>:first-child]:left-0",
              "[&_tbody_tr>:first-child]:z-[1] [&_tbody_tr>:first-child]:bg-card",
              "[&_thead_tr>:first-child]:z-20",
            ],
            DENSITY_CELL_CLASSES[density],
            containerClassName,
          )}
          style={scrollStyle}
          data-density={density}
        >
          <table
            aria-label={ariaLabel}
            className={cn("w-full caption-bottom border-collapse text-sm", className)}
          >
            {children}
          </table>
        </div>
      </div>
    </AdminDataTableDensityContext.Provider>
  )
}

function DensityToggle({
  density,
  onChange,
}: {
  density: AdminDataTableDensity
  onChange: (density: AdminDataTableDensity) => void
}) {
  return (
    <div
      role="group"
      aria-label="Table density"
      className="inline-flex items-center rounded-md border border-border bg-background p-0.5"
    >
      <DensityOption
        active={density === "comfortable"}
        label="Comfortable"
        onClick={() => onChange("comfortable")}
      >
        <Rows2 className="h-4 w-4" aria-hidden />
      </DensityOption>
      <DensityOption
        active={density === "compact"}
        label="Compact"
        onClick={() => onChange("compact")}
      >
        <Rows3 className="h-4 w-4" aria-hidden />
      </DensityOption>
    </div>
  )
}

function DensityOption({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  )
}
