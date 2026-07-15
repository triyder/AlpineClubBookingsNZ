"use client"

import * as React from "react"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

type CheckboxProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "type"
> & {
  onCheckedChange?: (checked: boolean) => void
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({
  className,
  onCheckedChange,
  ...props
}, ref) {
  // The input and the tick share ONE grid cell (both pinned to col/row-start-1)
  // and the wrapper centres its items, so the size-3.5 tick sits optically
  // centred in the size-4 box instead of the old absolute icon that hugged the
  // top-left corner (#156).
  return (
    <span className="relative inline-grid size-4 shrink-0 place-items-center align-middle">
      <input
        ref={ref}
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          "peer col-start-1 row-start-1 size-4 shrink-0 appearance-none rounded-[4px] border border-input shadow-xs transition-shadow outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 checked:border-primary checked:bg-primary checked:text-primary-foreground dark:bg-input/30 dark:aria-invalid:ring-destructive/40 dark:checked:bg-primary",
          className
        )}
        onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
        {...props}
      />
      <CheckIcon
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 hidden size-3.5 text-primary-foreground peer-checked:block"
      />
    </span>
  )
})

export { Checkbox }
