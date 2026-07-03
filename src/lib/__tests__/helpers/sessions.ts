/**
 * Typed test helpers for next-auth Session values.
 *
 * Use these instead of `as any` casts on auth() mock returns so that test
 * code keeps full type feedback when the Session interface changes.
 */
import type { Session } from "next-auth";

type SessionUser = Session["user"];

const DEFAULT_USER: SessionUser = {
  id: "test-user",
  email: "test-user@example.org",
  name: "Test User",
  role: "USER",
  accessRoles: ["USER"],
  forcePasswordChange: false,
  isEmailVerified: true,
  twoFactorRequired: false,
  twoFactorVerified: false,
  twoFactorEnrolled: false,
  twoFactorMethod: null,
};

export function makeSession(user: Partial<SessionUser> = {}): Session {
  return {
    user: { ...DEFAULT_USER, ...user },
    expires: "2099-01-01T00:00:00.000Z",
  };
}

export function adminSession(overrides: Partial<SessionUser> = {}): Session {
  return makeSession({
    id: "admin-1",
    email: "admin@example.org",
    name: "Admin One",
    role: "ADMIN",
    accessRoles: ["ADMIN"],
    ...overrides,
  });
}

export function memberSession(overrides: Partial<SessionUser> = {}): Session {
  return makeSession({
    id: "member-1",
    email: "member@example.org",
    name: "Member One",
    role: "USER",
    accessRoles: ["USER"],
    ...overrides,
  });
}

export function lodgeSession(overrides: Partial<SessionUser> = {}): Session {
  return makeSession({
    id: "lodge-1",
    email: "lodge@example.org",
    name: "Lodge Account",
    role: "LODGE",
    accessRoles: ["LODGE"],
    ...overrides,
  });
}
