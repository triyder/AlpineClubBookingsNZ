"use client"

/**
 * The one place every Booking Policies section shows the outcome of a write
 * (#2142 review).
 *
 * Both halves are LIVE REGIONS, and they are deliberately not the same kind:
 *
 *  - `role="alert"` (assertive) for the error. A failed save — including the
 *    shared 403 "This change was not saved" copy — contradicts what the admin
 *    believes just happened. A polite region waits for a lull that may never
 *    come, so the admin carries on believing the policy changed when it did
 *    not. Interrupting is proportionate to that, and it matches the house
 *    precedent for exactly this copy: `AdminForbiddenSaveNotice` in
 *    `src/components/admin/view-only-action.tsx` is already `role="alert"`.
 *  - `role="status"` (polite) for the success. A confirmation is not urgent and
 *    interrupting the next action to say "saved" is noise; polite is the right
 *    trade for a message that only reassures.
 *
 * Both wrappers are rendered UNCONDITIONALLY and only their CONTENT is gated,
 * for the same reason `AdminViewOnlySectionBanner` does it: a live region
 * injected into the accessibility tree already populated, in a single mutation,
 * is announced by some screen-reader/browser pairings and silently dropped by
 * others. The wrappers are therefore mounted from the first paint, and the
 * message lands as a content change inside a region that is already registered.
 *
 * That guarantee is only as good as where the adopter PUTS this component, and
 * getting it wrong is easy (#2142 review, round 4): every adopting section has
 * a loading state, and rendering this below an early return for it re-created
 * the very bug the unconditional wrappers exist to prevent — a failed FIRST
 * load mounted the section and its already-populated alert in one mutation.
 * MOUNT THIS ABOVE THE LOADING STATE, not inside the loaded branch: all three
 * booking-policy sections render the banner, this component, and the scope
 * select in every state, and swap only the cards below them. `AGENTS.md` and
 * `docs/ARCHITECTURE.md` state the rule; `save-view-only-gating.test.tsx` pins
 * it.
 *
 * Consequence for adopters: because these wrappers always exist, this component
 * sits OUTSIDE the section's `space-y-*` stack (next to the view-only banner,
 * which is outside for the same reason) and the spacing lives on the inner box,
 * which only exists when there is something to show. Rendering it inside the
 * stack would leave two permanent empty children and a dead gap at the top of
 * every section.
 */
export function PolicyFeedback({
  error,
  success,
  onClearError,
  onClearSuccess,
}: {
  error: string
  success: string
  onClearError: () => void
  onClearSuccess: () => void
}) {
  return (
    <>
      <div role="alert">
        {error ? (
          <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md mb-6">
            {error}
            <button onClick={onClearError} className="ml-2 underline">
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
      <div role="status">
        {success ? (
          <div className="bg-green-50 text-green-800 px-4 py-3 rounded-md border border-green-200 mb-6">
            {success}
            <button onClick={onClearSuccess} className="ml-2 underline">
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
    </>
  )
}
