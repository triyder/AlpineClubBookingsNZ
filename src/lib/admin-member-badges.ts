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
  NONE: "bg-muted text-muted-foreground border-border",
  VIEWER: "bg-warning-3 text-warning-11 border-warning-6",
  MANAGER: "bg-success-3 text-success-11 border-success-6",
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
    className: "bg-accent text-foreground border-border hover:bg-accent",
  },
  Cancelled: {
    label: "Cancelled" as const,
    className: "bg-warning-3 text-warning-11 border-warning-6 hover:bg-warning-3",
  },
  Active: {
    label: "Active" as const,
    className: "bg-success-3 text-success-11 hover:bg-success-4 border-success-6",
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
  className: "bg-muted text-muted-foreground border-border",
  label: "Can Login",
} as const;

// test seam
export const NON_LOGIN_BADGE = {
  className: "bg-cat1-3 text-cat1-11 border-cat1-6",
  label: "Non-Login",
} as const;

export function getLoginBadge(canLogin: boolean) {
  return canLogin ? LOGIN_BADGE : NON_LOGIN_BADGE;
}
