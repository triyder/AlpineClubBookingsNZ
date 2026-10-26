"use client"

import { useCallback, useId } from "react"

/**
 * The row-button names the booking-period and minimum-stay lists share (#4116):
 * the `triggerProps` keys a return finds each row's buttons by, and the heading
 * that names them. Both lists mark Edit with `rowKey` (where an editor's Cancel
 * and a delete return to) and Activate/Deactivate with `toggleKey` (where a
 * toggle returns to); nothing returns to a Delete.
 */
export const rowKey = (id: string) => `row-${id}`
export const toggleKey = (id: string) => `toggle-${id}`

/**
 * Each row's heading describes its buttons, so a screen reader announces which
 * row an "Edit, button" belongs to: `headingProps(id)` on the row's title and
 * `describedBy(id)` on each of its buttons.
 */
export function useRowHeadings() {
  const base = useId()
  const headingProps = useCallback((id: string) => ({ id: `${base}${id}` }), [base])
  const describedBy = useCallback(
    (id: string) => ({ "aria-describedby": `${base}${id}` }),
    [base],
  )
  return { headingProps, describedBy }
}
