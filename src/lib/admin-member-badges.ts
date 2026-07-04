/**
 * Shared admin-member display helpers.
 *
 * The admin members list (`/admin/members`) and member detail
 * (`/admin/members/[id]`) pages both render finance access, lifecycle,
 * and login badges. Keeping the badge class maps and lifecycle helper
 * in one place stops the two pages drifting on colour/label decisions.
 *
 * The two pages disagree on finance access label phrasing (the list
 * prefers short labels like "Viewer", detail prefers long labels like
 * "Finance Viewer"). Both phrasings are exported here so each page
 * keeps the copy it already ships with.
 */
import type { FinanceAccessLevel } from "@prisma/client";

// test seam
export const financeAccessBadgeClass: Record<FinanceAccessLevel, string> = {
  NONE: "bg-slate-100 text-slate-700 border-slate-200",
  VIEWER: "bg-amber-100 text-amber-800 border-amber-200",
  MANAGER: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

// test seam
export const financeAccessShortLabels: Record<FinanceAccessLevel, string> = {
  NONE: "None",
  VIEWER: "Viewer",
  MANAGER: "Manager",
};

// test seam
export const financeAccessLongLabels: Record<FinanceAccessLevel, string> = {
  NONE: "No Finance Access",
  VIEWER: "Finance Viewer",
  MANAGER: "Finance Manager",
};

export type MemberLifecycleInput = {
  active: boolean;
  cancelledAt: Date | string | null;
  archivedAt: Date | string | null;
};

export type LifecycleStatusConfig = {
  label: "Active" | "Inactive" | "Cancelled" | "Archived";
  className: string;
};

const LIFECYCLE_CONFIG = {
  Archived: {
    label: "Archived" as const,
    className: "bg-slate-200 text-slate-800 border-slate-300 hover:bg-slate-200",
  },
  Cancelled: {
    label: "Cancelled" as const,
    className: "bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100",
  },
  Active: {
    label: "Active" as const,
    className: "bg-green-100 text-green-800 hover:bg-green-200 border-green-200",
  },
  Inactive: {
    label: "Inactive" as const,
    className: "",
  },
} satisfies Record<LifecycleStatusConfig["label"], LifecycleStatusConfig>;

/**
 * Pick the badge label + colour class for a member's lifecycle state.
 * Archive wins over cancellation; cancellation wins over inactive.
 */
export function getLifecycleStatusConfig(
  member: MemberLifecycleInput,
): LifecycleStatusConfig {
  if (member.archivedAt) return LIFECYCLE_CONFIG.Archived;
  if (member.cancelledAt) return LIFECYCLE_CONFIG.Cancelled;
  if (member.active) return LIFECYCLE_CONFIG.Active;
  return LIFECYCLE_CONFIG.Inactive;
}

// test seam
export const LOGIN_BADGE = {
  className: "bg-slate-100 text-slate-700 border-slate-200",
  label: "Can Login",
} as const;

// test seam
export const NON_LOGIN_BADGE = {
  className: "bg-purple-100 text-purple-800 border-purple-200",
  label: "Non-Login",
} as const;

export function getLoginBadge(canLogin: boolean) {
  return canLogin ? LOGIN_BADGE : NON_LOGIN_BADGE;
}
