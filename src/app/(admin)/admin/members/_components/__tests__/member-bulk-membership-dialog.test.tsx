// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest"
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemberBulkMembershipDialog } from "../member-bulk-membership-dialog"

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}))

const TYPES = {
  membershipTypes: [
    { id: "type-a", name: "Full", isActive: true },
    { id: "type-b", name: "Archived", isActive: false },
  ],
}

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response
}

function routedFetch(handlers: {
  types?: unknown
  preview?: unknown
  save?: unknown
}) {
  return vi.fn(async (url: string) => {
    if (url === "/api/admin/membership-types") return jsonResponse(handlers.types ?? TYPES)
    if (url.endsWith("/preview")) return jsonResponse(handlers.preview ?? {})
    return jsonResponse(handlers.save ?? {})
  })
}

const previewBody = {
  seasonYear: 2026,
  membershipTypeId: "type-a",
  summary: {
    requested: 2,
    previewed: 2,
    changed: 2,
    unchanged: 0,
    skipped: 0,
    ageTierChanges: 0,
    linkedGuestBlocks: 0,
    affectedTotals: { futureConfirmedBookings: 3, draftBookings: 0, waitlistRecords: 0 },
  },
  members: [
    {
      memberId: "m1",
      name: "Alice",
      previewToken: "tok-1",
      affectedCounts: { futureConfirmedBookings: 3, draftBookings: 0, waitlistRecords: 0 },
      changed: true,
      currentAgeTier: "ADULT",
      resultingAgeTier: "ADULT",
      ageTierChanged: false,
      linkedGuestBlocked: false,
      linkedGuestBookings: { count: 0 },
    },
    {
      memberId: "m2",
      name: "Bob",
      previewToken: "tok-2",
      affectedCounts: { futureConfirmedBookings: 0, draftBookings: 0, waitlistRecords: 0 },
      changed: true,
      currentAgeTier: "ADULT",
      resultingAgeTier: "ADULT",
      ageTierChanged: false,
      linkedGuestBlocked: false,
      linkedGuestBookings: { count: 0 },
    },
  ],
  skipped: [],
}

function renderDialog(overrides: Partial<Record<string, unknown>> = {}) {
  const onComplete = vi.fn()
  const onError = vi.fn()
  render(
    <MemberBulkMembershipDialog
      open
      selectedIds={new Set(["m1", "m2"])}
      memberNames={new Map([["m1", "Alice"], ["m2", "Bob"]])}
      onOpenChange={vi.fn()}
      onComplete={onComplete}
      onError={onError}
      {...overrides}
    />,
  )
  return { onComplete, onError }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("MemberBulkMembershipDialog (#2107)", () => {
  it("walks preview → reason → confirm and reports the changed count", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        preview: previewBody,
        save: {
          outcomeCounts: { changed: 2, unchanged: 0, stale: 0, blocked_linked_guests: 0, error: 0 },
          results: [
            { memberId: "m1", outcome: "changed" },
            { memberId: "m2", outcome: "changed" },
          ],
        },
      }),
    )

    const { onComplete } = renderDialog()

    // Only the ACTIVE type is offered.
    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    expect(screen.queryByRole("option", { name: "Archived" })).not.toBeInTheDocument()

    // Pick the type (first combobox) and preview.
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))

    await waitFor(() =>
      expect(screen.getByText(/2 of 2 will change/)).toBeInTheDocument(),
    )
    expect(screen.getByText(/Existing bookings are not repriced/)).toBeInTheDocument()

    // Reason step → confirm.
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), {
      target: { value: "season start" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(onComplete).toHaveBeenCalledWith(2)
  })

  it("offers Preview again when a save returns stale outcomes", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({
        preview: previewBody,
        save: {
          outcomeCounts: { changed: 1, unchanged: 0, stale: 1, blocked_linked_guests: 0, error: 0 },
          results: [
            { memberId: "m1", outcome: "changed" },
            { memberId: "m2", outcome: "stale", error: "Preview again" },
          ],
        },
      }),
    )

    renderDialog()

    await waitFor(() => expect(screen.getByRole("option", { name: "Full" })).toBeInTheDocument())
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: "type-a" } })
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    await waitFor(() => expect(screen.getByText(/2 of 2 will change/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "season start" } })
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }))

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview again" })).toBeInTheDocument(),
    )
    // The stale member is surfaced with its name for re-preview.
    expect(screen.getByText("Bob")).toBeInTheDocument()

    // Preview again re-runs the preview and returns to the preview step.
    fireEvent.click(screen.getByRole("button", { name: "Preview again" }))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument(),
    )
  })
})
