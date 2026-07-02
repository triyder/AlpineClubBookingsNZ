import { NextResponse } from "next/server";
import { hasAdminPortalAccess } from "@/lib/admin-permissions";

/**
 * Drop-in `requireAdmin` implementation for tests that mock
 * "@/lib/session-guards". Mirrors the real guard's 401/403 semantics but
 * delegates to the test's mocked `auth()` and `requireActiveSessionUser()`
 * so per-test session and active-member setups keep working.
 *
 * Usage inside a vi.mock factory:
 *
 *   vi.mock("@/lib/session-guards", () => ({
 *     requireAdmin: async () =>
 *       (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
 *     requireActiveSessionUser: ...,
 *   }));
 */
export async function evaluateRequireAdminMock() {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (!hasAdminPortalAccess(session.user)) {
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
