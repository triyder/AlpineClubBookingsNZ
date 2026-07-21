// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// FIX-2 (#2079): the interim in-app Xero credential entry section. Asserts
// Full-Admin vs area-admin gating, metadata-only display (values never
// round-trip), and that Save POSTs the typed value write-only.

const mockUseSession = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

import { XeroCredentialsSection } from "../xero-credentials-section";

const METADATA = {
  provider: "xero",
  credentials: {
    client_id: {
      set: true,
      setAt: "2026-07-21T10:00:00.000Z",
      secretSource: "AUTH_SECRET",
    },
    // client_secret + webhook_key intentionally absent → "Not set".
  },
};

function mockFetchRouting() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/api/admin/integrations/credentials")) {
      return {
        ok: true,
        json: async () => METADATA,
      } as unknown as Response;
    }
    if (method === "POST") {
      return {
        ok: true,
        json: async () => ({ ok: true }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("XeroCredentialsSection gating + display", () => {
  it("shows the view-only banner and a disabled Edit for a non-Full admin", async () => {
    mockFetchRouting();
    mockUseSession.mockReturnValue({
      data: { user: { accessRoles: ["FINANCE_ADMIN"] } },
    });

    render(<XeroCredentialsSection />);

    await waitFor(() =>
      expect(screen.getByText(/view-only access to this area/i)).toBeTruthy(),
    );
    const edit = screen.getByRole("button", { name: /edit/i });
    expect((edit as HTMLButtonElement).disabled).toBe(true);
    // Metadata display: client_id set, secret not set — never a value.
    expect(screen.getByText(/Set ✓/)).toBeTruthy();
    expect(screen.getAllByText(/Not set/).length).toBeGreaterThan(0);
  });

  it("lets a Full Admin edit and write a value (write-only POST, no round-trip)", async () => {
    const fetchMock = mockFetchRouting();
    mockUseSession.mockReturnValue({
      data: { user: { accessRoles: ["ADMIN"] } },
    });

    render(<XeroCredentialsSection />);

    // Wait for the metadata load, then enter edit mode.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /edit/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /edit/i }));

    const secretInput = screen.getByLabelText("Client Secret") as HTMLInputElement;
    fireEvent.change(secretInput, { target: { value: "brand-new-secret" } });

    fireEvent.click(screen.getByRole("button", { name: /save credentials/i }));

    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        provider: "xero",
        key: "client_secret",
        value: "brand-new-secret",
      });
    });

    // Verify-reset consequence surfaced after saving client_secret.
    await waitFor(() =>
      expect(screen.getByText(/connection was reset/i)).toBeTruthy(),
    );
  });
});
