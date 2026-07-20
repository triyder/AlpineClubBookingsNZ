// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { ADMIN_FORBIDDEN_SAVE_REASON } from "@/components/admin/view-only-action";

const hookMock = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hookMock.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { GoogleSecurityCard } from "@/components/admin/google-security-card";

// Edit-gated Login & Security Google card (#2103). Loads read-only; the enable
// toggle stages behind Edit → Save/Cancel; nothing auto-persists; Save writes
// the modules route once (GET-fresh-then-merge). The credentials warning keys
// off the STAGED value.

const NOTICE_RE = /can view login & security settings but cannot change them/i;
const WARNING_RE = /Google credentials not configured/i;

function renderCard(
  overrides: { googleLogin?: boolean; credentialsConfigured?: boolean } = {},
) {
  return render(
    <GoogleSecurityCard
      moduleSettings={{
        ...DEFAULT_MODULE_SETTINGS,
        googleLogin: overrides.googleLogin ?? false,
      }}
      credentialsConfigured={overrides.credentialsConfigured ?? true}
    />,
  );
}

function toggle() {
  return screen.getByRole("checkbox", {
    name: /enable google sign-in/i,
  }) as HTMLInputElement;
}

function editButton() {
  return screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement;
}

describe("GoogleSecurityCard (#2103)", () => {
  beforeEach(() => {
    hookMock.canEdit = true;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads read-only: the toggle is disabled and there is no Save button", () => {
    renderCard({ googleLogin: true });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(true);
    expect(editButton().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("Edit enables the toggle and reveals Save/Cancel", () => {
    renderCard();
    fireEvent.click(editButton());
    expect(toggle().disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("toggling in edit mode fires NO fetch and flags unsaved changes", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCard();
    fireEvent.click(editButton());
    fireEvent.click(toggle());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/unsaved changes/i)).toBeTruthy();
  });

  it("previews the credentials warning off the STAGED value before Save", () => {
    renderCard({ googleLogin: false, credentialsConfigured: false });
    // Off by default -> no warning.
    expect(screen.queryByText(WARNING_RE)).toBeNull();
    fireEvent.click(editButton());
    fireEvent.click(toggle()); // stage enable
    expect(screen.getByText(WARNING_RE)).toBeTruthy();
  });

  it("Save merges the staged toggle over the FRESH modules GET and PUTs once", async () => {
    const freshSettings = {
      ...DEFAULT_MODULE_SETTINGS,
      googleLogin: false,
      twoFactor: true,
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/modules" && !init?.method) {
        return new Response(JSON.stringify({ settings: freshSettings }), {
          status: 200,
        });
      }
      if (url === "/api/admin/modules" && init?.method === "PUT") {
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard({ googleLogin: false });
    fireEvent.click(editButton());
    fireEvent.click(toggle()); // stage googleLogin -> true
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );

    const getCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/admin/modules" && !init?.method,
    );
    const putCalls = fetchMock.mock.calls.filter(
      ([url, init]) => url === "/api/admin/modules" && init?.method === "PUT",
    );
    expect(getCalls).toHaveLength(1);
    expect(putCalls).toHaveLength(1);

    const body = JSON.parse(String(putCalls[0][1]?.body));
    expect(body.settings.googleLogin).toBe(true);
    expect(body.settings.twoFactor).toBe(true); // merged over FRESH, not snapshot
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });

  it("Cancel reverts the staged toggle with zero fetches and exits edit mode", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCard({ googleLogin: false });
    fireEvent.click(editButton());
    fireEvent.click(toggle());
    expect(toggle().checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("surfaces the forbidden-save reason on a 403 from the modules PUT", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/admin/modules" && !init?.method) {
        return new Response(
          JSON.stringify({ settings: DEFAULT_MODULE_SETTINGS }),
          { status: 200 },
        );
      }
      if (url === "/api/admin/modules" && init?.method === "PUT") {
        return new Response(null, { status: 403 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderCard({ googleLogin: false });
    fireEvent.click(editButton());
    fireEvent.click(toggle());
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  it("canEdit=false disables Edit and shows the view-only notice", () => {
    hookMock.canEdit = false;
    renderCard();
    expect(editButton().disabled).toBe(true);
    expect(screen.getByText(NOTICE_RE)).toBeTruthy();
  });

  it("canEdit=undefined (resolving) disables Edit and shows NO notice", () => {
    hookMock.canEdit = undefined;
    renderCard();
    expect(editButton().disabled).toBe(true);
    expect(screen.queryByText(NOTICE_RE)).toBeNull();
  });
});
