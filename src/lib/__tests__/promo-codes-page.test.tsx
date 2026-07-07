// @vitest-environment jsdom

import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyAdminPermissionMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

import { PromoCodesPageClient } from "@/app/(admin)/admin/promo-codes/promo-codes-page-client";

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

// The promo-codes list always resolves to []; the Xero reference fetches
// (chart-of-accounts + items) take the configured status so we can drive the
// permission-denied and genuine-failure paths independently.
function stubFetch(xeroStatus = 200) {
  const calls: string[] = [];
  const xeroOk = xeroStatus >= 200 && xeroStatus < 300;
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("xero/chart-of-accounts")) {
      return {
        ok: xeroOk,
        status: xeroStatus,
        json: async () => ({
          accounts: [{ code: "201", name: "Sales", type: "REVENUE" }],
        }),
      };
    }
    if (url.includes("xero/items")) {
      return {
        ok: xeroOk,
        status: xeroStatus,
        json: async () => ({ items: [{ code: "X", name: "Item" }] }),
      };
    }
    return { ok: true, status: 200, json: async () => [] };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function openForm() {
  const addButton = await screen.findByRole("button", {
    name: "Add Promo Code",
  });
  fireEvent.click(addButton);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PromoCodesPageClient — permission-aware Xero reference fetch (#1598)", () => {
  it("fetches Xero reference data when the viewer has finance access", async () => {
    const { calls } = stubFetch(200);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit", finance: "view" })}
      />,
    );
    await openForm();

    await waitFor(() => {
      expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(true);
    });
    // With Xero data loaded, the codes are chosen from a Select, not typed.
    expect(screen.queryByPlaceholderText("e.g. PROMO-DISC")).toBeNull();
  });

  it("skips the finance-area fetch and shows manual inputs for a viewer without finance access", async () => {
    const { calls } = stubFetch(200);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit" })}
      />,
    );
    await openForm();

    // Manual entry inputs appear immediately; the Xero fetch never fires.
    expect(await screen.findByPlaceholderText("e.g. PROMO-DISC")).toBeTruthy();
    expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(false);
    expect(calls.some((u) => u.includes("xero/items"))).toBe(false);
  });

  it("degrades quietly on a 403 — no error banner, manual inputs remain", async () => {
    const { calls } = stubFetch(403);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit", finance: "view" })}
      />,
    );
    await openForm();

    await waitFor(() => {
      expect(calls.some((u) => u.includes("xero/chart-of-accounts"))).toBe(true);
    });
    expect(screen.queryByText(/Enter the codes manually below/)).toBeNull();
    expect(screen.getByPlaceholderText("e.g. PROMO-DISC")).toBeTruthy();
  });

  it("keeps the amber note on a genuine 500 (Xero not connected)", async () => {
    stubFetch(500);
    render(
      <PromoCodesPageClient
        permissionMatrix={matrix({ bookings: "edit", finance: "view" })}
      />,
    );
    await openForm();

    // A 5xx is a real failure, not a permission denial: the informational
    // fallback note is preserved.
    expect(
      await screen.findByText(/Enter the codes manually below/),
    ).toBeTruthy();
  });
});
