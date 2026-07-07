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
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }),
}));
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
  LodgeSelect: () => null,
  initialLodgeIdFromLocation: () => null,
}));

import { RoomsBedsManager } from "@/components/admin/rooms-beds-manager";

const ROOMS_PAYLOAD = {
  rooms: [],
  capacity: {
    capacity: 0,
    source: "club_config" as const,
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 0,
  },
  canImportFromConfig: false,
  configBeds: [],
};

function matrix(
  overrides: Partial<AdminPermissionMatrix>,
): AdminPermissionMatrix {
  return { ...emptyAdminPermissionMatrix(), ...overrides };
}

function stubFetch(status = 200, body: unknown = ROOMS_PAYLOAD) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown) => {
    calls.push(String(input));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RoomsBedsManager — permission-aware bookings-area gating (#1598)", () => {
  it("renders the manager when the viewer has bookings access", async () => {
    stubFetch();
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Rooms & Beds")).toBeTruthy();
    });
  });

  it("renders nothing (no fetch) for a lodge viewer without bookings access", async () => {
    const { calls } = stubFetch();
    const { container } = render(
      <RoomsBedsManager permissionMatrix={matrix({ lodge: "edit" })} />,
    );

    // No async load to await; the gate short-circuits synchronously.
    await waitFor(() => {
      expect(calls).toHaveLength(0);
    });
    expect(screen.queryByText("Rooms & Beds")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing quietly on a 403 from the bed-allocation load (no toast)", async () => {
    const sonner = await import("sonner");
    stubFetch(403, { error: "Forbidden" });
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Rooms & Beds")).toBeNull();
    });
    expect(sonner.toast.error).not.toHaveBeenCalled();
  });

  it("does NOT quiet-hide on a genuine 500 — keeps the shell and toasts the failure", async () => {
    const sonner = await import("sonner");
    stubFetch(500, { error: "Boom" });
    render(
      <RoomsBedsManager
        permissionMatrix={matrix({ lodge: "edit", bookings: "view" })}
      />,
    );

    // A 5xx is a real failure, not a permission denial: the manager stays
    // mounted (heading visible) and surfaces the error via toast.
    await waitFor(() => {
      expect(sonner.toast.error).toHaveBeenCalled();
    });
    expect(screen.getByText("Rooms & Beds")).toBeTruthy();
  });
});
