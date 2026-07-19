import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSION_AREAS,
  type AdminPermissionLevel,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

// The /login/enroll and /login/verify pages are the single authoritative site
// that resolves the post-login DEFAULT landing after the 2FA detour (#2090).
// Resolving here — server-side, from the live session's preference + admin
// matrix — makes the post-detour destination deterministic (D-D4): an
// admin-access member reaching enrollment/verification with no deep link lands
// on their first accessible admin page, a genuine deep link still wins, and a
// plain member lands on /dashboard. No raced post-signIn resolver fetch is
// involved, so the detour never bakes a stale /dashboard default (the alice/bob
// asymmetry this suite guards against).

const { mockAuth, mockRedirect } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

// Capture the callbackUrl the page hands the panel without rendering the real
// (client, hook-driven) panel — the page returns the element, so its props are
// the post-detour destination under test.
vi.mock("../two-factor-panels", () => ({
  TwoFactorEnrollPanel: (props: { callbackUrl: string }) => props,
  TwoFactorVerifyPanel: (props: {
    callbackUrl: string;
    enrolledMethod: string;
  }) => props,
}));

import EnrollPage from "../enroll/page";
import VerifyPage from "../verify/page";

function matrix(
  overrides: Partial<AdminPermissionMatrix> = {},
): AdminPermissionMatrix {
  const base = Object.fromEntries(
    ADMIN_PERMISSION_AREAS.map((area) => [area.key, "none"]),
  ) as Record<string, AdminPermissionLevel>;
  return { ...base, ...overrides } as AdminPermissionMatrix;
}

function sessionUser(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: "member-1",
      forcePasswordChange: false,
      twoFactorRequired: true,
      twoFactorVerified: false,
      twoFactorEnrolled: false,
      twoFactorMethod: null,
      postLoginLanding: null,
      adminPermissionMatrix: matrix(),
      ...overrides,
    },
  };
}

async function runEnroll(callbackUrl?: string) {
  return EnrollPage({
    searchParams: Promise.resolve(callbackUrl ? { callbackUrl } : {}),
  });
}

async function runVerify(callbackUrl?: string) {
  return VerifyPage({
    searchParams: Promise.resolve(callbackUrl ? { callbackUrl } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
});

describe("/login/enroll post-detour landing (#2090)", () => {
  it("resolves an admin-access enrollee with no deep link to their first admin page", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runEnroll()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/admin/payments");
  });

  it("lets a genuine deep link win over the admin role default", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runEnroll("/nominations/tok")) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/nominations/tok");
  });

  it("lands a plain member on /dashboard", async () => {
    mockAuth.mockResolvedValue(sessionUser());

    const element = (await runEnroll()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it("honours a MEMBER_DASHBOARD preference for an admin enrollee", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        postLoginLanding: "MEMBER_DASHBOARD",
        adminPermissionMatrix: matrix({ finance: "view" }),
      }),
    );

    const element = (await runEnroll()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it("redirects an already-enrolled session to /login/verify with no baked landing", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorEnrolled: true,
        twoFactorMethod: "TOTP",
        adminPermissionMatrix: matrix({ finance: "view" }),
      }),
    );

    // Anchored: a baked-in "?callbackUrl=…" would defeat this assertion if it
    // were a substring match (vitest toThrow(string) matches substrings).
    await expect(runEnroll()).rejects.toThrow(/redirect:\/login\/verify$/);
  });

  it("redirects an already-verified session to the resolved landing", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({
        twoFactorVerified: true,
        adminPermissionMatrix: matrix({ finance: "view" }),
      }),
    );

    await expect(runEnroll()).rejects.toThrow("redirect:/admin/payments");
  });

  it("sends an anonymous visitor back to /login", async () => {
    mockAuth.mockResolvedValue(null);
    await expect(runEnroll()).rejects.toThrow(/redirect:\/login/);
  });
});

describe("/login/verify post-detour landing (#2090)", () => {
  const enrolled = { twoFactorEnrolled: true, twoFactorMethod: "TOTP" as const };

  it("resolves an admin-access member with no deep link to their first admin page", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ ...enrolled, adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runVerify()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/admin/payments");
  });

  it("lets a genuine deep link win over the admin role default", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ ...enrolled, adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    const element = (await runVerify("/nominations/tok")) as unknown as {
      props: { callbackUrl: string };
    };
    expect(element.props.callbackUrl).toBe("/nominations/tok");
  });

  it("lands a plain member on /dashboard", async () => {
    mockAuth.mockResolvedValue(sessionUser(enrolled));

    const element = (await runVerify()) as unknown as { props: { callbackUrl: string } };
    expect(element.props.callbackUrl).toBe("/dashboard");
  });

  it("redirects an unenrolled session to /login/enroll with no baked landing", async () => {
    mockAuth.mockResolvedValue(
      sessionUser({ adminPermissionMatrix: matrix({ finance: "view" }) }),
    );

    // Anchored so a baked-in "?callbackUrl=…" cannot slip past a substring match.
    await expect(runVerify()).rejects.toThrow(/redirect:\/login\/enroll$/);
  });
});
