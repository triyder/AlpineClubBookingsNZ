import type { PostLoginLanding } from "@prisma/client";
import { DEFAULT_POST_LOGIN_PATH, getExplicitCallbackUrl } from "@/lib/auth-redirect";
import {
  getFirstAccessibleAdminHref,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";

/**
 * Resolve where a member lands after authentication (#2090).
 *
 * Precedence, highest first:
 *   1. A genuinely explicit (user/deep-link-supplied) safe `callbackUrl` — it
 *      always wins, over both the preference and the role default (D-D4). A
 *      value the login flow itself materialised (the 2FA detour, a provider
 *      callbackUrl) must NOT be passed in as `explicitCallbackUrl`, so it never
 *      counts as explicit here.
 *   2. An explicit MEMBER_DASHBOARD preference — pins /dashboard even for a
 *      member with admin access.
 *   3. Everything else — an ADMIN_DASHBOARD preference AND the null role
 *      default — resolves to `getFirstAccessibleAdminHref(matrix) ?? "/dashboard"`,
 *      NOT a literal /admin/dashboard: an admin's matrix can deny the overview
 *      area while allowing other admin pages (D-D3). A plain member's matrix
 *      grants no admin area, so this is /dashboard; a demoted admin holding a
 *      stale ADMIN_DASHBOARD preference likewise falls through to /dashboard —
 *      the same safe target the admin-layout guard bounces to, never a 403 loop.
 */
export function resolvePostLoginLandingPath(args: {
  explicitCallbackUrl?: string | null;
  landingPreference?: PostLoginLanding | null;
  permissionInput: AdminPermissionInput;
}): string {
  const explicit = getExplicitCallbackUrl(args.explicitCallbackUrl);
  if (explicit) {
    return explicit;
  }

  if (args.landingPreference === "MEMBER_DASHBOARD") {
    return DEFAULT_POST_LOGIN_PATH;
  }

  return (
    getFirstAccessibleAdminHref(args.permissionInput) ?? DEFAULT_POST_LOGIN_PATH
  );
}
