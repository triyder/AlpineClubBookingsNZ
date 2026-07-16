import { NextResponse } from "next/server";
import {
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  type AdminAccessRequirement,
} from "@/lib/admin-permissions";

type RequireAdminMockOptions = {
  permission?: AdminAccessRequirement | false;
};

/**
 * Drop-in `requireAdmin` implementation for tests that mock
 * "@/lib/session-guards". Mirrors the real guard's 401/403 semantics but
 * delegates to the test's mocked `auth()` and `requireActiveSessionUser()`
 * so per-test session and active-member setups keep working.
 *
 * When the route passes an explicit `permission` requirement (the #1927
 * content routes do), this honours it via `hasAdminAreaAccess` so a
 * per-area view-vs-edit denial is exercised end-to-end. With no options it
 * keeps the historical broad portal-access check.
 *
 * Usage inside a vi.mock factory:
 *
 *   vi.mock("@/lib/session-guards", () => ({
 *     requireAdmin: async (options) =>
 *       (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(options),
 *     requireActiveSessionUser: ...,
 *   }));
 */
export async function evaluateRequireAdminMock(
  options: RequireAdminMockOptions = {},
) {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const requirement =
    options.permission === false ? null : (options.permission ?? null);
  const hasAccess = requirement
    ? hasAdminAreaAccess(session.user, requirement)
    : hasAdminPortalAccess(session.user);
  if (!hasAccess) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  const { requireActiveSessionUser } = await import("@/lib/session-guards");
  const inactive = await requireActiveSessionUser(session.user.id);
  if (inactive) {
    return { ok: false as const, response: inactive };
  }
  return { ok: true as const, session };
}
