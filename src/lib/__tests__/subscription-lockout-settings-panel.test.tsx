// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { SubscriptionLockoutSettingsPanel } from "@/components/admin/subscription-lockout-settings-panel";

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

// Routes each endpoint to a 200 body by default; `overrides` forces a status on
// any URL matched by substring so a single fetch can be denied/failed.
function stubFetch(
  overrides: Record<string, { status: number; body?: unknown }> = {},
) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(overrides).find((k) => url.includes(k));
    if (key) {
      const { status, body } = overrides[key];
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body ?? {},
      };
    }
    let body: unknown = {};
    if (url.includes("membership-lockout-settings")) {
      body = {
        settings: {
          enabled: false,
          financialYearEndMonthOverride: null,
          textFallbackEnabled: false,
        },
      };
    } else if (url.includes("xero/account-mappings")) {
      body = { subscriptionIncome: { code: null, itemCode: null } };
    } else if (url.includes("xero/chart-of-accounts")) {
      body = { accounts: [] };
    } else if (url.includes("xero/items")) {
      body = { items: [] };
    } else if (url.includes("xero/organisation")) {
      body = { financialYearEndMonth: 3 };
    } else if (url.includes("age-tier-settings")) {
      body = { settings: [] };
    }
    return { ok: true, status: 200, json: async () => body };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SubscriptionLockoutSettingsPanel — permission-aware cross-area sections (#1598)", () => {
  it("renders every card when the viewer holds all backing areas", async () => {
    stubFetch();
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "edit",
          finance: "edit",
          bookings: "edit",
        })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Booking lockout")).toBeTruthy();
    });
    expect(screen.getByText("Paid-subscription detection")).toBeTruthy();
    expect(screen.getByText("Age tiers")).toBeTruthy();
  });

  it("hides the finance and bookings cards (and skips their fetches) for a membership-only viewer", async () => {
    const { calls } = stubFetch();
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({ support: "view", membership: "edit" })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Booking lockout")).toBeTruthy();
    });
    // Cross-area sections hidden by matrix…
    expect(screen.queryByText("Paid-subscription detection")).toBeNull();
    expect(screen.queryByText("Age tiers")).toBeNull();
    // …and their backing endpoints were never fetched.
    expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(false);
    expect(calls.some((u) => u.includes("age-tier-settings"))).toBe(false);
    expect(calls.some((u) => u.includes("membership-lockout-settings"))).toBe(
      true,
    );
  });

  it("renders nothing (no fetch) when the viewer lacks membership — the backbone area", async () => {
    const { calls } = stubFetch();
    const { container } = render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({ support: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Loading settings…")).toBeNull();
    });
    expect(screen.queryByText("Booking lockout")).toBeNull();
    expect(container.firstChild).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("renders nothing quietly on a 403 from the backbone settings load (no toast)", async () => {
    const sonner = await import("sonner");
    stubFetch({ "membership-lockout-settings": { status: 403 } });
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "edit",
          finance: "edit",
          bookings: "edit",
        })}
      />,
    );

    // Starts on the loading state, then unmounts to null once forbidden resolves.
    await waitFor(() => {
      expect(screen.queryByText("Loading settings…")).toBeNull();
    });
    expect(screen.queryByText("Booking lockout")).toBeNull();
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it("does NOT quiet-hide on a genuine 500 from the backbone load", async () => {
    // `forbidden` (the render-nothing backstop) must flip only on 401/403. A
    // 500 on the membership backbone leaves the panel on its loading state — it
    // never resolves to null the way a 403 does — so a genuine failure stays
    // distinguishable from a permission denial.
    const { fetchMock } = stubFetch({
      "membership-lockout-settings": { status: 500 },
    });
    render(
      <SubscriptionLockoutSettingsPanel
        permissionMatrix={matrix({
          support: "view",
          membership: "edit",
          finance: "edit",
          bookings: "edit",
        })}
      />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Let the 500 response resolve and the load's finally run.
    await new Promise((resolve) => setTimeout(resolve));
    // Still loading (not hidden): a 403 here would have rendered null instead.
    expect(screen.getByText("Loading settings…")).toBeTruthy();
  });
});
