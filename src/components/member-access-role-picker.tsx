"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { AdminPermissionMatrixTable } from "@/components/admin-permission-matrix-table";
import {
  previewMatrixForTokens,
  type AccessRoleOption,
} from "@/lib/access-role-definitions";

export function MemberAccessRolePicker({
  roleOptions,
  accessRoles,
  canLogin,
  disabled = false,
  disabledMessage,
  actorIsFullAdmin = true,
  memberPrivilege = null,
  onToggleRole,
}: {
  /** Database-backed role options (system roles + definitions). */
  roleOptions: readonly AccessRoleOption[];
  /** Selected role tokens: enum values or definition ids. */
  accessRoles: readonly string[];
  canLogin: boolean;
  disabled?: boolean;
  disabledMessage?: string;
  /**
   * When false, the actor is a scoped admin: privileged role checkboxes are
   * disabled (the server 403s such writes, issue #1012), and if the member
   * already holds a privileged role (`memberPrivilege`) the whole picker is
   * disabled — any reclassification of such a member requires Full Admin.
   */
  actorIsFullAdmin?: boolean;
  /**
   * Whether the member being edited holds a privileged role: "live" on their
   * effective access roles, or "dormant" only via stored legacy role fields
   * (archive/cancel clears canLogin but not the role fields; see #1027/#1038).
   */
  memberPrivilege?: "live" | "dormant" | null;
  onToggleRole: (token: string, checked: boolean) => void;
}) {
  const matrix = previewMatrixForTokens(
    canLogin ? accessRoles : [],
    roleOptions,
  );
  const scopedActor = !actorIsFullAdmin;
  const lockedForScopedAdmin = scopedActor && memberPrivilege !== null;
  const controlsDisabled = disabled || !canLogin || lockedForScopedAdmin;
  const scopedAdminMessage = lockedForScopedAdmin
    ? memberPrivilege === "live"
      ? "Only a Full Admin can change this member's access roles."
      : "This member holds a dormant privileged legacy role, so any reclassification (including User/Org) requires Full Admin."
    : scopedActor && !disabled
      ? "Granting or revoking privileged roles requires Full Admin; you can still manage User and Organisation classification."
      : null;

  return (
    <fieldset className="space-y-4 rounded-md border border-slate-200 p-4">
      <legend className="px-1 text-sm font-medium">Access Roles</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {roleOptions.map((option) => (
          <label
            key={option.token}
            className="flex items-start gap-3 rounded-md border border-slate-200 p-3"
          >
            <Checkbox
              checked={accessRoles.includes(option.token)}
              disabled={controlsDisabled || (scopedActor && option.privileged)}
              onCheckedChange={(checked) =>
                onToggleRole(option.token, checked === true)
              }
            />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{option.label}</span>
              <span className="block text-xs text-muted-foreground">
                {option.description}
              </span>
            </span>
          </label>
        ))}
      </div>

      <AdminPermissionMatrixTable matrix={matrix} />

      {disabledMessage && (
        <p className="text-xs text-muted-foreground">{disabledMessage}</p>
      )}
      {scopedAdminMessage && (
        <p className="text-xs text-muted-foreground">{scopedAdminMessage}</p>
      )}
      {!canLogin && (
        <p className="text-xs text-muted-foreground">
          Access roles only apply to login-enabled records.
        </p>
      )}
    </fieldset>
  );
}
