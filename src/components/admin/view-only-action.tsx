"use client";

import { useId, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { cn } from "@/lib/utils";

interface ViewOnlyActionButtonProps extends ButtonProps {
  // Tri-state (#2065): `undefined` while the session is resolving. Neutral
  // treatment for that window = disabled WITHOUT the view-only reason, so an
  // edit-capable admin never flashes the reason and a view-only admin never
  // flashes an enabled control. The read-only reason is only exposed once we
  // know the admin is view-only (`canEdit === false`).
  canEdit: boolean | undefined;
  readOnlyReason?: string;
  /**
   * Whether THIS button explains its own view-only state (#2142 owner
   * decision). Default `true` — the historical behaviour every admin surface
   * outside Booking Policies still relies on: a `title`, an `aria-describedby`,
   * and an sr-only line carrying {@link readOnlyReason}.
   *
   * Pass `false` where the surrounding section already renders an
   * {@link AdminViewOnlySectionBanner}. A `disabled` button is out of the tab
   * order, so a keyboard user never lands on it and never meets the
   * `aria-describedby` reason in the normal flow — a screen-reader user CAN
   * still reach it in browse/virtual mode, so "unreachable" overstates it, but
   * only by going looking for a control they have already been given no reason
   * to expect. The `title` is worse than hard to reach: it never appears at all
   * here, because `buttonVariants` sets `disabled:pointer-events-none`
   * (`src/components/ui/button.tsx`), so a disabled `Button` receives no hover
   * event and the browser's native tooltip is never triggered. The banner says
   * it once, in the reading order, in a live region; repeating it per button
   * then only adds noise. Gating stays exactly the same either way: this prop
   * changes where the EXPLANATION lives, never whether the button is disabled.
   */
  describeReason?: boolean;
}

export function ViewOnlyActionButton({
  canEdit,
  readOnlyReason = ADMIN_VIEW_ONLY_ACTION_REASON,
  describeReason = true,
  disabled,
  title,
  "aria-describedby": ariaDescribedBy,
  children,
  ...props
}: ViewOnlyActionButtonProps) {
  const reasonId = useId();
  // Only a resolved view-only admin gets the read-only reason/affordance…
  const isReadOnly = canEdit === false;
  // …but the button stays disabled until we positively know editing is allowed,
  // so the resolving window (undefined) is a neutral disabled state.
  const isDisabled = canEdit !== true || disabled;
  // Opted out => the caller's own title/aria-describedby survive untouched.
  const annotate = isReadOnly && describeReason;

  return (
    <>
      <Button
        {...props}
        disabled={isDisabled}
        title={annotate ? readOnlyReason : title}
        aria-describedby={annotate ? reasonId : ariaDescribedBy}
      >
        {children}
      </Button>
      {annotate ? (
        <span id={reasonId} className="sr-only">
          {readOnlyReason}
        </span>
      ) : null}
    </>
  );
}

/**
 * Message shown when a save is rejected with 403 — the defense-in-depth case
 * behind the UI gating (#1927): a stale tab that still shows live editors
 * because the actor's permissions were narrowed after the page loaded.
 */
export const ADMIN_FORBIDDEN_SAVE_REASON =
  "This change was not saved: your admin role can view this area but cannot make changes. Refresh the page to see the latest permissions.";

export function AdminForbiddenSaveNotice({
  className,
  children = ADMIN_FORBIDDEN_SAVE_REASON,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800",
        className,
      )}
    >
      {children}
    </p>
  );
}

/**
 * Headline for the section-level view-only banner (#2142 owner decision).
 * Deliberately addressed to the person ("You have…") rather than to their role,
 * because it is read on arrival at the section, not hung off a control.
 */
export const ADMIN_VIEW_ONLY_SECTION_HEADING =
  "You have view-only access to this area";

/**
 * Section-level view-only banner (#2142 owner decision).
 *
 * The per-button affordance it replaces was, at best, hard to meet: a disabled
 * button is out of the tab order, so a keyboard user never lands on it and
 * never encounters the `aria-describedby` reason in the normal flow (a screen
 * reader can still traverse a disabled button in browse/virtual mode, but only
 * by going looking). The `title` was strictly worse — `buttonVariants` sets
 * `disabled:pointer-events-none`, so a disabled `Button` fires no hover event
 * and the native tooltip never appears at all. Saying it once at the top of the
 * section fixes both halves of that:
 *
 *  - it sits in the normal reading order, ahead of the controls it explains, so
 *    it is met before the dead buttons rather than after; and
 *  - `role="status"` (an implicit polite live region) announces it when its
 *    CONTENT appears, which is the real arrival moment here — `canEdit` is
 *    tri-state and resolves from `undefined` AFTER hydration.
 *
 * That second half is why the `role="status"` wrapper is rendered
 * UNCONDITIONALLY and only its content is gated. A polite live region has to be
 * registered in the accessibility tree BEFORE its content changes: a region
 * injected already-populated in a single mutation is announced by some
 * screen-reader/browser pairings and silently dropped by others (VoiceOver with
 * Safari notably). Adopting sections must therefore also mount this component
 * ABOVE their own loading early-return, so the region exists from the first
 * paint rather than from whenever the section's fetch settles. The empty
 * wrapper renders no visible box and takes no layout space — every style lives
 * on the inner element, which only exists once `canEdit === false`.
 *
 * Same tri-state contract as {@link AdminViewOnlyNotice}: the banner CONTENT
 * appears only once we positively know the admin is view-only, so it never
 * flashes while the session is still resolving. `canEdit` is required for the
 * same reason — a default would fire on an explicitly-passed `undefined`.
 *
 * Adopters pass the section-specific detail as `children`; the shared heading
 * is what makes it recognisable as the same banner from section to section.
 * `className` lands on the inner box (not the wrapper) so a spacing utility
 * applies only when there is something to space. Currently adopted by the five
 * Booking Policies sections only — the rest of the admin tree still uses
 * {@link AdminViewOnlyNotice} plus the per-button reason. Rolling this wider is
 * tracked in #2160.
 */
export function AdminViewOnlySectionBanner({
  className,
  children,
  canEdit,
}: {
  className?: string;
  children?: ReactNode;
  canEdit: boolean | undefined;
}) {
  return (
    // The testid scopes a test's "the view-only banner" query away from the
    // section's OTHER live regions — `PolicyFeedback` renders a permanently
    // mounted `role="status"` for its success copy — the same way
    // `data-testid="booking-detail-content"` scopes content queries away from
    // the booking detail page's section rail. Counting `role="status"` nodes
    // globally would otherwise pin an unrelated component's a11y shape.
    <div role="status" data-testid="admin-view-only-banner">
      {canEdit === false ? (
        <div
          className={cn(
            "rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700",
            className,
          )}
        >
          <span className="font-medium">{ADMIN_VIEW_ONLY_SECTION_HEADING}.</span>
          {children ? <span> {children}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

export function AdminViewOnlyNotice({
  className,
  children = ADMIN_VIEW_ONLY_ACTION_REASON,
  canEdit,
}: {
  className?: string;
  children?: ReactNode;
  /**
   * Tri-state edit access for the gated area (#2065). The banner renders only
   * once we positively know the admin is view-only (`canEdit === false`). While
   * the session is resolving (`undefined`) — or if the admin can edit
   * (`true`) — it renders nothing, so the "view only" banner never flashes
   * during the post-hydration session fetch. This prop is REQUIRED at every
   * call site: there is deliberately no default, because a default would fire
   * on an explicitly-passed `undefined` (the resolving state) and wrongly show
   * the banner. Panels whose edit flag is server/prop-computed pass that
   * boolean directly (it is never `undefined`).
   */
  canEdit: boolean | undefined;
}) {
  if (canEdit !== false) return null;

  return (
    <p
      className={cn(
        "rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600",
        className,
      )}
    >
      {children}
    </p>
  );
}
