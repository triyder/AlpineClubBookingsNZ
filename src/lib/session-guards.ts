import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type SessionUser = {
  id: string;
  role: string;
  email?: string | null;
};

type RequireAdminResult =
  | { ok: true; session: { user: SessionUser } }
  | { ok: false; response: NextResponse };

type RequireActiveSessionResult =
  | { ok: true; session: { user: SessionUser } }
  | { ok: false; response: NextResponse };

type RequireAdminOptions = {
  unauthenticatedResponse?: () => NextResponse;
  forbiddenResponse?: () => NextResponse;
};

type RequireActiveSessionOptions = RequireActiveSessionUserOptions & {
  unauthenticatedResponse?: () => NextResponse;
};

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function unauthorisedResponse() {
  return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
}

function forbiddenResponse() {
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * Shared admin auth helper. Returns the session on success; otherwise
 * a NextResponse with the correct 401 vs 403 split and the active
 * session check applied. Use at the top of admin route handlers:
 *
 *   const guard = await requireAdmin();
 *   if (!guard.ok) return guard.response;
 *   const session = guard.session;
 */
export async function requireAdmin(
  options: RequireAdminOptions = {}
): Promise<RequireAdminResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: options.unauthenticatedResponse?.() ?? unauthorizedResponse(),
    };
  }
  if (session.user.role !== "ADMIN") {
    return {
      ok: false,
      response: options.forbiddenResponse?.() ?? forbiddenResponse(),
    };
  }
  const inactive = await requireActiveSessionUser(session.user.id);
  if (inactive) {
    return { ok: false, response: inactive };
  }
  return { ok: true, session: { user: session.user as SessionUser } };
}

type RequireActiveSessionUserOptions = {
  allowForcePasswordChange?: boolean;
};

/**
 * Shared active-session API helper for member-facing routes. It preserves the
 * existing member-route behavior: a missing session is 401 "Unauthorised" and
 * active/force-password-change checks are delegated to requireActiveSessionUser.
 */
export async function requireActiveSession(
  options: RequireActiveSessionOptions = {}
): Promise<RequireActiveSessionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false,
      response: options.unauthenticatedResponse?.() ?? unauthorisedResponse(),
    };
  }

  const inactive = await requireActiveSessionUser(session.user.id, {
    allowForcePasswordChange: options.allowForcePasswordChange,
  });
  if (inactive) {
    return { ok: false, response: inactive };
  }

  return { ok: true, session: { user: session.user as SessionUser } };
}

export async function requireActiveSessionUser(
  userId: string,
  options: RequireActiveSessionUserOptions = {}
) {
  const member = await prisma.member.findUnique({
    where: { id: userId },
    select: {
      active: true,
      forcePasswordChange: true,
    },
  });

  if (!member?.active) {
    return NextResponse.json(
      { error: "Account is deactivated" },
      { status: 403 }
    );
  }

  if (member.forcePasswordChange && !options.allowForcePasswordChange) {
    return NextResponse.json(
      { error: "Password change required" },
      { status: 403 }
    );
  }

  return null;
}
