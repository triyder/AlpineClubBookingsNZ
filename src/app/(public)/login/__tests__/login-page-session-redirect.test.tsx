import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
