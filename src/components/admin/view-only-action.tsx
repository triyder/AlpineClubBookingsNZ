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
}

export function ViewOnlyActionButton({
  canEdit,
  readOnlyReason = ADMIN_VIEW_ONLY_ACTION_REASON,
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

  return (
    <>
      <Button
        {...props}
        disabled={isDisabled}
        title={isReadOnly ? readOnlyReason : title}
        aria-describedby={isReadOnly ? reasonId : ariaDescribedBy}
      >
        {children}
      </Button>
      {isReadOnly ? (
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
