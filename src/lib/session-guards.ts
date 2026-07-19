import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type { PostLoginLanding } from "@prisma/client";
import { auth } from "@/lib/auth";
import {
  dedupeAccessRoles,
  hasAdminAccess,
  type AppAccessRole,
} from "@/lib/access-roles";
import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  getAdminPermissionMatrix,
  getAdminRouteRequirement,
  hasAdminAreaAccess,
  type AdminAccessRequirement,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import {
  REQUEST_METHOD_HEADER,
  REQUEST_PATH_HEADER,
} from "@/lib/internal-return-path";
import { prisma } from "@/lib/prisma";
import {
  isTwoFactorSessionBlocked,
  type TwoFactorSessionUser,
} from "@/lib/two-factor-gate";

type SessionUser = {
  id: string;
  role: string;
  accessRoles: AppAccessRole[];
  adminPermissionMatrix?: AdminPermissionMatrix;
  email?: string | null;
  twoFactorRequired?: boolean;
  twoFactorVerified?: boolean;
  twoFactorEnrolled?: boolean;
  twoFactorMethod?: "TOTP" | "EMAIL" | null;
  postLoginLanding?: PostLoginLanding | null;
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
  permission?: AdminAccessRequirement | false;
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

function twoFactorRequiredResponse() {
  return NextResponse.json(
    { error: "Two-factor verification required" },
    { status: 403 },
  );
}

async function inferAdminAccessRequirement(
  options: RequireAdminOptions,
): Promise<AdminAccessRequirement | null> {
  if (options.permission === false) return null;
  if (options.permission) return options.permission;

  try {
    const requestHeaders = await headers();
    const pathname = requestHeaders.get(REQUEST_PATH_HEADER);
    if (!pathname) return null;
    return getAdminRouteRequirement(
      pathname,
      requestHeaders.get(REQUEST_METHOD_HEADER),
    );
  } catch {
    return null;
  }
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

  const [member, requirement] = await Promise.all([
    prisma.member.findUnique({
      where: { id: session.user.id },
      select: {
        active: true,
        forcePasswordChange: true,
        twoFactorEnabled: true,
        // Joined definitions so area checks resolve definition-backed
        // (custom or edited) access roles.
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      },
    }),
    inferAdminAccessRequirement(options),
  ]);

  if (!member?.active) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Account is deactivated" },
        { status: 403 }
      ),
    };
  }

  const hasRequiredAccess = requirement
    ? hasAdminAreaAccess(member, requirement)
    : hasAdminAccess(member);

  if (!hasRequiredAccess) {
    return {
      ok: false,
      response: options.forbiddenResponse?.() ?? forbiddenResponse(),
    };
  }

  if (member.forcePasswordChange) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Password change required" },
        { status: 403 }
      ),
    };
  }

  if (
    isTwoFactorSessionBlocked({
      sessionUser: session.user,
      member,
    })
  ) {
    return { ok: false, response: twoFactorRequiredResponse() };
  }

  return {
    ok: true,
    session: {
      user: {
        ...(session.user as SessionUser),
        // DB-verified roles so downstream separation-of-duties checks
        // (issue #1012) never trust a stale JWT claim.
        accessRoles: dedupeAccessRoles(
          member.accessRoles.map(({ role }) => role),
        ),
        // DB-verified matrix for the same reason (#1367): downstream area
        // checks on this user resolve from the rows this guard just read
        // (definitions joined), not the JWT-carried snapshot.
        adminPermissionMatrix: getAdminPermissionMatrix(member),
      },
    },
  };
}

type RequireActiveSessionUserOptions = {
  allowForcePasswordChange?: boolean;
  sessionUser?: TwoFactorSessionUser | null;
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
    sessionUser: session.user,
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
      twoFactorEnabled: true,
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

  const sessionUser = options.sessionUser ?? (await auth())?.user;
  if (
    sessionUser?.id === userId &&
    isTwoFactorSessionBlocked({
      sessionUser,
      member,
      allowForcePasswordChange: options.allowForcePasswordChange,
    })
  ) {
    return twoFactorRequiredResponse();
  }

  return null;
}
