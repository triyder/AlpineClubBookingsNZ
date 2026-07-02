"use client";

import { Checkbox } from "@/components/ui/checkbox";
import {
  ADMIN_PERMISSION_AREAS,
  getAdminPermissionMatrix,
  type AdminPermissionLevel,
} from "@/lib/admin-permissions";
import {
  ACCESS_ROLE_DESCRIPTIONS,
  ACCESS_ROLE_LABELS,
  ACCESS_ROLE_VALUES,
  type AppAccessRole,
} from "@/lib/access-roles";
import { cn } from "@/lib/utils";

const LEVEL_LABELS: Record<AdminPermissionLevel, string> = {
  none: "None",
  view: "View",
  edit: "Edit",
};

const LEVEL_CLASSES: Record<AdminPermissionLevel, string> = {
  none: "border-slate-200 bg-slate-50 text-slate-500",
  view: "border-blue-200 bg-blue-50 text-blue-700",
  edit: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

export function MemberAccessRolePicker({
  accessRoles,
  canLogin,
  disabled = false,
  disabledMessage,
  onToggleRole,
}: {
  accessRoles: readonly AppAccessRole[];
  canLogin: boolean;
  disabled?: boolean;
  disabledMessage?: string;
  onToggleRole: (role: AppAccessRole, checked: boolean) => void;
}) {
  const matrix = getAdminPermissionMatrix({ accessRoles, canLogin });
  const controlsDisabled = disabled || !canLogin;

  return (
    <fieldset className="space-y-4 rounded-md border border-slate-200 p-4">
      <legend className="px-1 text-sm font-medium">Access Roles</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {ACCESS_ROLE_VALUES.map((role) => (
          <label
            key={role}
            className="flex items-start gap-3 rounded-md border border-slate-200 p-3"
          >
            <Checkbox
              checked={accessRoles.includes(role)}
              disabled={controlsDisabled}
              onCheckedChange={(checked) =>
                onToggleRole(role, checked === true)
              }
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">
                {ACCESS_ROLE_LABELS[role]}
              </span>
              <span className="block text-xs text-muted-foreground">
                {ACCESS_ROLE_DESCRIPTIONS[role]}
              </span>
            </span>
          </label>
        ))}
      </div>

      <div className="rounded-md border border-slate-200">
        <div className="grid grid-cols-[1fr_auto] gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase text-slate-500">
          <span>Admin Area</span>
          <span>Access</span>
        </div>
        <div className="divide-y divide-slate-200">
          {ADMIN_PERMISSION_AREAS.map((area) => {
            const level = matrix[area.key];
            return (
              <div
                key={area.key}
                className="grid grid-cols-[1fr_auto] gap-3 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium text-slate-900">
                    {area.label}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {area.description}
                  </div>
                </div>
                <span
                  className={cn(
                    "self-center rounded-full border px-2 py-0.5 text-xs font-semibold",
                    LEVEL_CLASSES[level],
                  )}
                >
                  {LEVEL_LABELS[level]}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {disabledMessage && (
        <p className="text-xs text-muted-foreground">{disabledMessage}</p>
      )}
      {!canLogin && (
        <p className="text-xs text-muted-foreground">
          Access roles only apply to login-enabled records.
        </p>
      )}
    </fieldset>
  );
}
