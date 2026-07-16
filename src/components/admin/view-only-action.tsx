"use client";

import { useId, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import { cn } from "@/lib/utils";

interface ViewOnlyActionButtonProps extends ButtonProps {
  canEdit: boolean;
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
  const isReadOnly = !canEdit;

  return (
    <>
      <Button
        {...props}
        disabled={isReadOnly || disabled}
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
}: {
  className?: string;
  children?: ReactNode;
}) {
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
