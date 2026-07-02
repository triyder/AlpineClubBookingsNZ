import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { REQUEST_PATH_HEADER } from "@/lib/internal-return-path";

const { mockAuth, mockRedirect, mockHeaders } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
  mockHeaders: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => mockRedirect(path),
}));

vi.mock("next/headers", () => ({
  headers: () => mockHeaders(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: vi.fn() },
    booking: { findFirst: vi.fn() },
  },
}));

// The layout fetches current site banners; none are needed here (and the
// real module imports "server-only", which vitest cannot resolve).
vi.mock("@/lib/site-banners", () => ({
  getCurrentSiteBanners: vi.fn(async () => []),
}));

// Stub the layout's UI dependencies so importing it stays light; the anonymous
// redirect path returns before any of these are rendered.
vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/nav-bar", () => ({ NavBar: () => null }));
vi.mock("@/components/member-onboarding-wizard", () => ({
  MemberOnboardingWizard: () => null,
}));
vi.mock("@/components/report-issue-widget", () => ({
  ReportIssueWidget: () => null,
}));

describe("authenticated layout return path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`);
    });
  });

  it("redirects anonymous visitors to login, preserving the requested path", async () => {
    mockAuth.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(
      new Headers({ [REQUEST_PATH_HEADER]: "/dashboard?tab=bookings" })
    );

    const { default: AuthenticatedLayout } = await import(
      "@/app/(authenticated)/layout"
    );

    await expect(
      AuthenticatedLayout({ children: "secure" })
    ).rejects.toThrow("redirect:/login?callbackUrl=%2Fdashboard%3Ftab%3Dbookings");
  });

  it("falls back to /dashboard when no requested path header is present", async () => {
    mockAuth.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(new Headers());

    const { default: AuthenticatedLayout } = await import(
      "@/app/(authenticated)/layout"
    );

    await expect(
      AuthenticatedLayout({ children: "secure" })
    ).rejects.toThrow("redirect:/login?callbackUrl=%2Fdashboard");
  });
});
