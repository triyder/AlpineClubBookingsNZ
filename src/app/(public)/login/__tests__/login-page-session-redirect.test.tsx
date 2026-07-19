import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// The authenticated self-heal: /login must never render the sign-in form for
// a live session (the silent login loop, #1669) — it redirects through the
// same gates as login/verify: forced password change, then the two-factor
// funnel, then the sanitised callbackUrl.

const { mockAuth, mockRedirect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("@/lib/public-layout-config", () => ({
  getCachedEffectiveModuleFlags: () => Promise.resolve({ magicLink: false }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: (path: string) => mockRedirect(path),
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Alpine Club" }),
}));

import LoginPage from "../page";

function sessionUser(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: "member-1",
      email: "member@example.com",
      forcePasswordChange: false,
      twoFactorRequired: false,
      twoFactorVerified: false,
      twoFactorEnrolled: false,
      twoFactorMethod: null,
      ...overrides,
    },
  };
}

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {}
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"])
  ) as Record<string, AdminPermissionLevel>;
  return { ...base, ...overrides } as AdminPermissionMatrix;
}

async function runLoginPage(
  params: Record<string, string | string[] | undefined> = {}
) {
  return LoginPage({ searchParams: Promise.resolve(params) });
}

describe("LoginPage authenticated self-heal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("redirects an authenticated visitor to the callbackUrl", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/bookings");
  });

  it("falls back to /dashboard when no callbackUrl is present", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(runLoginPage()).rejects.toThrow("redirect:/dashboard");
  });

  it("self-heals an admin with no preference to their first accessible admin page", async () => {
    // Admin access but the overview area is denied, so the resolver must land on
    // the next accessible admin page (never a literal /admin/dashboard), proving
    // the self-heal honours getFirstAccessibleAdminHref rather than a constant.
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ bookings: "edit" }),
      })
    );

    await expect(runLoginPage()).rejects.toThrow("redirect:/admin/bookings");
  });

  it("lets an explicit callbackUrl win over an admin's role default", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ overview: "edit" }),
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/bookings");
  });

  it("honours a MEMBER_DASHBOARD preference for an admin self-heal", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: "MEMBER_DASHBOARD",
        adminPermissionMatrix: matrix({ overview: "edit" }),
      })
    );

    await expect(runLoginPage()).rejects.toThrow("redirect:/dashboard");
  });

  it("never redirects back into /login (loop guard)", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(
      runLoginPage({ callbackUrl: "/login?callbackUrl=%2Fdashboard" })
    ).rejects.toThrow("redirect:/dashboard");
  });

  it("drops an external callbackUrl and uses the default", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    await expect(
      runLoginPage({ callbackUrl: "https://evil.example/phish" })
    ).rejects.toThrow("redirect:/dashboard");
  });

  it("sends a forced password change to /change-password first", async () => {
    mockAuth.mockResolvedValue(sessionUser({ forcePasswordChange: true }));

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/change-password");
  });

  it("sends an unverified enrolled session to /login/verify with the callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/login/verify?callbackUrl=%2Fbookings");
  });

  it("sends an unverified unenrolled session to /login/enroll with the callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ twoFactorRequired: true, twoFactorEnrolled: false })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/login/enroll?callbackUrl=%2Fbookings");
  });

  it("sends an admin with no deep link into the detour WITHOUT baking a landing", async () => {
    // Determinism (#2090): the self-heal must not materialise the resolved
    // admin landing into the detour callbackUrl. With no explicit deep link the
    // detour carries no callbackUrl at all; /login/enroll re-resolves the same
    // default, so every entry into the detour lands identically.
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: false,
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ finance: "view" }),
      })
    );

    // Anchored so a baked-in "?callbackUrl=…" cannot slip past a substring match.
    await expect(runLoginPage()).rejects.toThrow(/redirect:\/login\/enroll$/);
  });

  it("still carries a genuine deep link into the detour callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
        postLoginLanding: null,
        adminPermissionMatrix: matrix({ finance: "view" }),
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/nominations/tok" })
    ).rejects.toThrow("redirect:/login/verify?callbackUrl=%2Fnominations%2Ftok");
  });

  it("redirects a verified two-factor session to the callbackUrl", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorRequired: true,
        twoFactorVerified: true,
        twoFactorEnrolled: true,
        twoFactorMethod: "totp",
      })
    );

    await expect(
      runLoginPage({ callbackUrl: "/bookings" })
    ).rejects.toThrow("redirect:/bookings");
  });

  it("still renders the form for an anonymous visitor", async () => {
    mockAuth.mockResolvedValue(null);

    const html = renderToStaticMarkup(await runLoginPage({}));

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(html).toContain("Sign in to your account to manage bookings");
  });

  it("renders the form when auth() returns a session without a user", async () => {
    mockAuth.mockResolvedValue({ user: undefined });

    const html = renderToStaticMarkup(await runLoginPage({}));

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(html).toContain("Sign in to your account to manage bookings");
  });
});
