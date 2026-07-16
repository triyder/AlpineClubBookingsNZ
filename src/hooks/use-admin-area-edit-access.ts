"use client";

import { useSession } from "next-auth/react";
import {
  hasAdminAreaAccess,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";

export const ADMIN_VIEW_ONLY_ACTION_REASON =
  "Your admin role can view this area but cannot make changes.";

export function useAdminAreaEditAccess(area: AdminPermissionArea) {
  const { data: session } = useSession();

  if (!session?.user) return false;

  return hasAdminAreaAccess(session.user, {
    area,
    level: "edit",
  });
}

/**
 * View-level variant for read-only actions (e.g. the Xero member-grouping
 * dry-run, E8 #1934) that are allowed to every admin who can see the area,
 * matching a route guard of requireAdmin({ permission: { area, level:
 * "view" } }).
 */
export function useAdminAreaViewAccess(area: AdminPermissionArea) {
  const { data: session } = useSession();

  if (!session?.user) return false;

  return hasAdminAreaAccess(session.user, {
    area,
    level: "view",
  });
}
