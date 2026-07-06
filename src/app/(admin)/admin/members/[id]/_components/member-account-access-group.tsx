"use client";

import { Badge } from "@/components/ui/badge";
import { getLoginBadge } from "@/lib/admin-member-badges";
import { accessRoleLabelForToken } from "@/lib/access-role-definitions";
import { useAccessRoleOptions } from "@/hooks/use-access-role-options";
import type { MemberDetail } from "../_types";

export function MemberAccountAccessGroup({ member }: { member: MemberDetail }) {
  const roleOptions = useAccessRoleOptions();
  const loginBadge = getLoginBadge(member.canLogin);
  const accessRoles = member.accessRoles ?? [];

  return (
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
        <dd className="font-medium">{member.active ? "Active" : "Inactive"}</dd>
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
  );
}
