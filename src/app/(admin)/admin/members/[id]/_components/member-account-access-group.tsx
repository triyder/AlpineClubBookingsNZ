"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Pencil } from "lucide-react";
import { MemberAccessRolePicker } from "@/components/member-access-role-picker";
import { getLoginBadge } from "@/lib/admin-member-badges";
import {
  hasPrivilegedAccess,
  normalizeAssignableAccessRoleTokens,
  storedAccessRolesForFullAdminGate,
} from "@/lib/access-roles";
import { accessRoleLabelForToken } from "@/lib/access-role-definitions";
import {
  buildAccessRolePatch,
  type MemberAccountEditForm,
} from "@/lib/admin-member-edit-groups";
import { useAccessRoleOptions } from "@/hooks/use-access-role-options";
import type { useInheritEmailSearch } from "../_hooks/use-inherit-email-search";
import type { MemberGroupEditState } from "../_hooks/use-member-group-edit";
import type { MemberDetail } from "../_types";

interface MemberAccountAccessGroupProps {
  member: MemberDetail;
  isSelf: boolean;
  actorIsFullAdmin: boolean;
  memberLifecycleLocked: boolean;
  edit: MemberGroupEditState<MemberAccountEditForm>;
  inheritEmail: ReturnType<typeof useInheritEmailSearch>;
}

export function MemberAccountAccessGroup({
  member,
  isSelf,
  actorIsFullAdmin,
  memberLifecycleLocked,
  edit,
  inheritEmail,
}: MemberAccountAccessGroupProps) {
  const roleOptions = useAccessRoleOptions();
  const loginBadge = getLoginBadge(member.canLogin);
  const accessRoles = member.accessRoles ?? [];
  // Mirror the server-side Full Admin gates (#1012/#1026/#1038) so scoped
  // admins see disabled controls instead of a 403 after the fact. "live" =
  // the member's effective roles are privileged; "dormant" = only the stored
  // legacy role fields are (archive/cancel clears canLogin, not the roles).
  const memberPrivilege: "live" | "dormant" | null = hasPrivilegedAccess(member)
    ? "live"
    : storedAccessRolesForFullAdminGate(member).some(
          (role) => role !== "USER" && role !== "ORG",
        )
      ? "dormant"
      : null;

  const { editing, form, saving, error, errorRef } = edit;

  if (editing && form) {
    const updateForm = edit.updateForm;
    const toggleAccessRole = (token: string, checked: boolean) => {
      updateForm((current) => {
        const nextRoles = normalizeAssignableAccessRoleTokens(
          checked
            ? [...current.accessRoles, token]
            : current.accessRoles.filter((value) => value !== token),
          { canLogin: current.canLogin },
        );
        return {
          ...current,
          ...buildAccessRolePatch(nextRoles, roleOptions),
        };
      });
    };

    return (
      <div className="space-y-4">
        {error && (
          <div
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="scroll-mt-20 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700 focus:outline-none"
          >
            {error}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-canLogin"
            checked={form.canLogin}
            onChange={(e) =>
              updateForm((f) => ({
                ...f,
                canLogin: e.target.checked,
                ...buildAccessRolePatch(
                  normalizeAssignableAccessRoleTokens(
                    e.target.checked
                      ? f.accessRoles.length > 0
                        ? f.accessRoles
                        : ["USER"]
                      : [],
                    { canLogin: e.target.checked },
                  ),
                  roleOptions,
                ),
              }))
            }
            className="h-4 w-4 rounded border-gray-300"
            disabled={isSelf || memberLifecycleLocked}
          />
          <Label htmlFor="account-canLogin">Can Login</Label>
          <p className="text-xs text-muted-foreground ml-2">
            Adults who can sign in and make bookings. Uncheck for infants,
            children, or youth managed by family group.
            {isSelf
              ? " You cannot disable login for your own admin account."
              : ""}
            {memberLifecycleLocked
              ? " Cancelled and archived members stay non-login."
              : ""}
          </p>
        </div>
        <MemberAccessRolePicker
          roleOptions={roleOptions}
          accessRoles={form.accessRoles}
          canLogin={form.canLogin}
          disabled={isSelf}
          disabledMessage={
            isSelf ? "You cannot change your own access roles." : undefined
          }
          actorIsFullAdmin={actorIsFullAdmin}
          memberPrivilege={memberPrivilege}
          onToggleRole={toggleAccessRole}
        />
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-active"
            checked={form.active}
            onChange={(e) =>
              updateForm((f) => ({ ...f, active: e.target.checked }))
            }
            className="h-4 w-4 rounded border-gray-300"
            disabled={isSelf || memberLifecycleLocked}
          />
          <Label htmlFor="account-active">Active</Label>
          {isSelf && (
            <span className="text-xs text-muted-foreground ml-1">
              (cannot deactivate own account)
            </span>
          )}
          {memberLifecycleLocked && (
            <span className="text-xs text-muted-foreground ml-1">
              (locked by lifecycle state)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-forcePasswordChange"
            checked={form.forcePasswordChange}
            onChange={(e) =>
              updateForm((f) => ({
                ...f,
                forcePasswordChange: e.target.checked,
              }))
            }
            className="h-4 w-4 rounded border-gray-300"
          />
          <Label htmlFor="account-forcePasswordChange">
            Force Password Change on Next Login
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="account-requiresInduction"
            checked={form.requiresInduction}
            onChange={(e) =>
              updateForm((f) => ({
                ...f,
                requiresInduction: e.target.checked,
              }))
            }
            className="h-4 w-4 rounded border-gray-300"
          />
          <Label htmlFor="account-requiresInduction">Requires Induction</Label>
          <p className="text-xs text-muted-foreground ml-2">
            Flag this member as needing to complete a lodge induction (outside
            the automatic new-member process).
          </p>
        </div>
        {!form.canLogin && (
          <div className="space-y-2">
            <Label htmlFor="account-inheritEmailSearch">
              Notification Email Recipient (optional)
            </Label>
            <p className="text-xs text-muted-foreground">
              Search for a primary adult member who should receive this
              member&apos;s notifications. Leave it blank to use this
              member&apos;s own email address instead.
            </p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              {inheritEmail.selected ? (
                <div className="space-y-2">
                  <div className="font-medium text-slate-900">
                    Sending notifications to {inheritEmail.selected.firstName}{" "}
                    {inheritEmail.selected.lastName}
                  </div>
                  <div className="text-xs text-slate-600">
                    {inheritEmail.selected.email} · Member ID{" "}
                    {inheritEmail.selected.id}
                    {inheritEmail.selected.active === false
                      ? " · Inactive"
                      : ""}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      inheritEmail.clear();
                      updateForm((f) => ({ ...f, inheritEmailFromId: null }));
                    }}
                  >
                    Use this member&apos;s own email instead
                  </Button>
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="font-medium text-slate-900">
                    Using this member&apos;s own email
                  </div>
                  <div className="text-xs text-slate-600">
                    {member.email || "No email set on this member"}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Input
                id="account-inheritEmailSearch"
                value={inheritEmail.search}
                onChange={(e) => inheritEmail.setSearch(e.target.value)}
                placeholder={
                  inheritEmail.selected
                    ? "Search to replace the selected adult"
                    : "Search adult members by name or email"
                }
              />
              {inheritEmail.searching ? (
                <p className="text-xs text-muted-foreground">
                  Searching eligible adult members...
                </p>
              ) : inheritEmail.error ? (
                <p className="text-xs text-red-600">{inheritEmail.error}</p>
              ) : inheritEmail.search.trim().length >= 2 ? (
                inheritEmail.results.length > 0 ? (
                  <div className="max-h-48 space-y-2 overflow-auto rounded-md border border-slate-200 bg-white p-2">
                    {inheritEmail.results.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        className="w-full rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50"
                        onClick={() => {
                          inheritEmail.select(candidate);
                          updateForm((f) => ({
                            ...f,
                            inheritEmailFromId: candidate.id,
                          }));
                        }}
                      >
                        <div className="font-medium text-slate-900">
                          {candidate.firstName} {candidate.lastName}
                        </div>
                        <div className="text-xs text-slate-600">
                          {candidate.email} · Member ID {candidate.id}
                          {candidate.active === false ? " · Inactive" : ""}
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No eligible primary adult members matched &quot;
                    {inheritEmail.search.trim()}&quot;.
                  </p>
                )
              ) : (
                <p className="text-xs text-muted-foreground">
                  Only primary adult members can be selected. Start typing at
                  least 2 characters to search.
                </p>
              )}
            </div>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={edit.cancelEdit} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void edit.save()} disabled={saving}>
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={edit.startEdit}>
          <Pencil className="h-4 w-4 mr-1" />
          Edit
        </Button>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Login</dt>
          <dd className="font-medium">
            <Badge variant="secondary" className={loginBadge.className}>
              {loginBadge.label}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Access Roles</dt>
          <dd className="flex flex-wrap gap-1 font-medium">
            {accessRoles.length > 0 ? (
              accessRoles.map((role) => (
                <Badge
                  key={role}
                  variant={role.startsWith("ADMIN") ? "default" : "secondary"}
                >
                  {accessRoleLabelForToken(role, roleOptions)}
                </Badge>
              ))
            ) : (
              <Badge variant="secondary">No Login</Badge>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Account Status</dt>
          <dd className="font-medium">
            {member.active ? "Active" : "Inactive"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Password Reset Required</dt>
          <dd className="font-medium">
            {member.forcePasswordChange ? "Yes" : "No"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Requires Induction</dt>
          <dd className="font-medium">
            {member.requiresInduction ? "Yes" : "No"}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Email Inheritance</dt>
          <dd className="font-medium">
            {member.inheritEmailFrom ? (
              <span className="text-xs">
                {member.inheritEmailFrom.firstName}{" "}
                {member.inheritEmailFrom.lastName}{" "}
                <span className="text-slate-400">
                  ({member.inheritEmailFrom.email})
                </span>
              </span>
            ) : (
              <span className="text-xs text-slate-500">Own email</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}
