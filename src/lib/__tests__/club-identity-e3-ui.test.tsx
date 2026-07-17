// @vitest-environment jsdom

// E3 #1929 UI regressions:
//   - The Lodges management page (multi-lodge hub) must expose an Address field
//     and send it in the create/edit payload, so the per-lodge {{lodge-address}}
//     token is populated for non-default lodges (docs "Adding a Second Lodge").
//   - LodgeDetailsPanel on /admin/appearance/identity loads via GET
//     /api/admin/lodges (lodge:view). A content-only admin gets a 403 there; that
//     must render an explanatory read-only notice, NOT a raw failure + Retry.

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1940: the Lodges page reads the session permission matrix for view-only
// gating; provide an edit-level admin session so the create-payload case works.
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "edit",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "edit",
          support: "edit",
        },
      },
    },
  }),
}));

const mocks = vi.hoisted(() => ({
  routerPush: vi.fn(),
  canEdit: vi.fn(() => true),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush, replace: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => mocks.canEdit(),
  // ViewOnlyActionButton (rendered by the now-gated Lodges page) imports this
  // reason string from the same module, so the mock must expose it too (#1940).
  ADMIN_VIEW_ONLY_ACTION_REASON:
    "Your admin role can view this area but cannot make changes.",
}));

import AdminLodgesPage from "@/app/(admin)/admin/lodges/page";
import { LodgeDetailsPanel } from "@/components/admin/lodge-details-panel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lodges page — address field (E3 #1929)", () => {
  it("renders an Address input and includes it in the create payload", async () => {
    const fetchBodies: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          fetchBodies.push({
            url,
            body: JSON.parse(String(init.body)),
          });
          return {
            ok: true,
            json: async () => ({ lodge: { id: "new-lodge" } }),
          };
        }
        return { ok: true, json: async () => ({ lodges: [] }) };
      }),
    );

    render(<AdminLodgesPage />);

    fireEvent.click(screen.getByRole("button", { name: /Add lodge/i }));

    const addressField = screen.getByLabelText("Address");
    expect(addressField).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "West Peak Lodge" },
    });
    fireEvent.change(addressField, {
      target: { value: "12 Alpine Road, Ohakune" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));

    await waitFor(() => expect(fetchBodies).toHaveLength(1));
    expect(fetchBodies[0].body).toMatchObject({
      name: "West Peak Lodge",
      address: "12 Alpine Road, Ohakune",
    });
    // A created lodge routes to its guided setup wizard.
    await waitFor(() =>
      expect(mocks.routerPush).toHaveBeenCalledWith(
        "/admin/lodges/new-lodge/setup",
      ),
    );
  });
});

describe("LodgeDetailsPanel — cross-area denial (E3 #1929)", () => {
  it("renders a read-only notice on a 403 instead of a raw failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) })),
    );

    render(<LodgeDetailsPanel />);

    await waitFor(() =>
      expect(
        screen.getByText(/does not include lodge access/i),
      ).toBeInTheDocument(),
    );
    // Not treated as a failure: no error toast, no generic error + Retry.
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(screen.queryByText("Could not load lodge details.")).toBeNull();
    expect(screen.queryByRole("button", { name: /Retry/i })).toBeNull();
  });

  it("still shows the generic error + Retry on a non-403 failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );

    render(<LodgeDetailsPanel />);

    await waitFor(() =>
      expect(
        screen.getByText("Could not load lodge details."),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalled();
    expect(screen.queryByText(/does not include lodge access/i)).toBeNull();
  });
});
