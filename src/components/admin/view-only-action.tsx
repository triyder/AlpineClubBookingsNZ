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
