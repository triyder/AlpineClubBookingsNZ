"use client";

import { useSession } from "next-auth/react";
import {
  hasAdminAreaAccess,
  type AdminPermissionArea,
} from "@/lib/admin-permissions";

export const ADMIN_VIEW_ONLY_ACTION_REASON =
  "Your admin role can view this area but cannot make changes.";

/**
 * Tri-state admin edit-access gate (#2065).
 *
 * Returns:
 * - `undefined` while the client session is still resolving (the
 *   post-hydration `/api/auth/session` fetch has not settled). Consumers must
 *   render a NEUTRAL state for this value: controls stay disabled/skeleton and
 *   NO "view only" banner is shown. This prevents a privileged admin from
 *   briefly seeing the view-only banner + disabled controls (which then pop to
 *   enabled), and — just as importantly — prevents a view-only admin from ever
 *   briefly seeing ENABLED controls during resolution.
 * - `true`  once resolved and the admin can edit the area.
 * - `false` once resolved and the admin can only view the area.
 *
 * `undefined` is falsy, so the common `disabled={!canEdit}` / `readOnly={!canEdit}`
 * idioms already treat the resolving window as disabled (the correct neutral).
 * The view-only banner/notice, however, must gate on `canEdit === false` (see
 * `AdminViewOnlyNotice`, `ViewOnlyActionButton`, and `WysiwygEditor`), never on
 * `!canEdit`, so it does not flash during resolution.
 */
export function useAdminAreaEditAccess(
  area: AdminPermissionArea,
): boolean | undefined {
  const { data: session, status } = useSession();

  // Session still resolving on the client: neutral, undecided state.
  if (status === "loading") return undefined;

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
 *
 * Tri-state like {@link useAdminAreaEditAccess}: `undefined` while the session
 * is resolving, so consumers render a neutral state instead of flashing a
 * no-access affordance (#2065).
 */
export function useAdminAreaViewAccess(
  area: AdminPermissionArea,
): boolean | undefined {
  const { data: session, status } = useSession();

  if (status === "loading") return undefined;

  if (!session?.user) return false;

  return hasAdminAreaAccess(session.user, {
    area,
    level: "view",
  });
}
