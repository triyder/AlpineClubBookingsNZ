import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  XCircle,
  type LucideIcon,
} from "lucide-react"

import { cn } from "@/lib/utils"

// Restrained Alpine (#1802): the shared inline callout primitive. Every variant
// pairs an icon with its text so status is never conveyed by colour alone, and
// colours come from the semantic CSS tokens (#1801 for success/warning, the
// additive --info trio here) so the callout dark-adapts. Convention: inline
// <Alert> for persistent state, sonner toast for transient feedback.
const alertVariants = cva(
  "flex w-full items-start gap-3 rounded-md border p-4 text-sm",
  {
    variants: {
      variant: {
        info: "border-info/20 bg-info-muted text-info",
        success: "border-success/20 bg-success-muted text-success",
        warning: "border-warning/20 bg-warning-muted text-warning",
        error: "border-danger/20 bg-danger-muted text-danger",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  }
)

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>["variant"]>

const variantIcon: Record<AlertVariant, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
}

// info/success are advisory ("status", announced politely); warning/error are
// assertive ("alert"). A caller may override with an explicit role prop.
const variantRole: Record<AlertVariant, "status" | "alert"> = {
  info: "status",
  success: "status",
  warning: "alert",
  error: "alert",
}

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title">,
    VariantProps<typeof alertVariants> {
  /** Optional bold heading rendered above the body/children. */
  title?: React.ReactNode
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, variant, title, role, children, ...props },
  ref
) {
  const resolvedVariant: AlertVariant = variant ?? "info"
  const Icon = variantIcon[resolvedVariant]

  return (
    <div
      ref={ref}
      role={role ?? variantRole[resolvedVariant]}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children}
      </div>
    </div>
  )
})

export { Alert, alertVariants }
