// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";

const hookMock = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hookMock.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

import { GroupDiscountSection } from "../group-discount-section";

// Reference implementation of the canonical settings-section pattern (#2136).
// The hook suite covers the draft/snapshot mechanics; this covers THIS card's
// own wiring — which control writes which `setDraft` key, the `parseInt || 5`
// fallback, the `loading || !draft` early return, and the PUT body.

const ENDPOINT = "/api/admin/booking-policies/group-discount";

const LOADED = { minGroupSize: 6, summerOnly: true, enabled: false };

function enabledBox() {
  return screen.getByLabelText("Enabled") as HTMLInputElement;
}

function minSizeInput() {
  return screen.getByLabelText("Minimum group size") as HTMLInputElement;
}

function renderSection() {
  return render(
    <ClubIdentityProvider value={clubIdentity}>
      <GroupDiscountSection />
    </ClubIdentityProvider>,
  );
}

/** Render and wait past the mount load. */
async function renderLoaded() {
  renderSection();
  await waitFor(() => expect(screen.getByLabelText("Enabled")).toBeTruthy());
}

describe("GroupDiscountSection (#2136)", () => {
  beforeEach(() => {
    hookMock.canEdit = true;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the loading placeholder until the mount load resolves", async () => {
    let release: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );

    renderSection();
    // `loading || !draft` early return: no form yet.
    expect(screen.getByText("Loading...")).toBeTruthy();
    expect(screen.queryByLabelText("Enabled")).toBeNull();

    release(new Response(JSON.stringify(LOADED), { status: 200 }));
    await waitFor(() => expect(screen.getByLabelText("Enabled")).toBeTruthy());
  });

  it("loads read-only, then Edit → change → Cancel reverts every control", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(LOADED), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await renderLoaded();

    // Read-only: the loaded values, controls disabled, no Save.
    expect(enabledBox().checked).toBe(false);
    expect(enabledBox().disabled).toBe(true);
    expect(minSizeInput().value).toBe("6");
    expect(
      screen.queryByRole("button", { name: "Save Group Discount" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(enabledBox().disabled).toBe(false);

    // Each control writes its own draft key; nothing auto-persists.
    fireEvent.click(enabledBox());
    fireEvent.change(minSizeInput(), { target: { value: "9" } });
    fireEvent.click(screen.getByLabelText("Summer seasons only"));
    expect(enabledBox().checked).toBe(true);
    expect(minSizeInput().value).toBe("9");
    expect(fetchMock).toHaveBeenCalledTimes(1); // the mount load only

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(enabledBox().checked).toBe(false);
    expect(minSizeInput().value).toBe("6");
    expect(
      (screen.getByLabelText("Summer seasons only") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(enabledBox().disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to 5 when the minimum-size field is cleared", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(LOADED), { status: 200 })),
    );
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    // `parseInt("") || 5` — an empty field must not stage NaN.
    fireEvent.change(minSizeInput(), { target: { value: "" } });
    expect(minSizeInput().value).toBe("5");
  });

  it("Save PUTs the staged draft and re-seeds from the SERVER response", async () => {
    // The server stores something other than what was submitted; the form must
    // end up showing the server's value, not the draft's.
    const stored = { minGroupSize: 4, summerOnly: false, enabled: true };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify({ id: "default", ...stored }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(LOADED), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(enabledBox());
    fireEvent.change(minSizeInput(), { target: { value: "9" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save Group Discount" }),
    );

    await waitFor(() =>
      expect(screen.getByText(/Group discount settings saved/i)).toBeTruthy(),
    );

    const putCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0][0]).toBe(ENDPOINT);
    expect(JSON.parse(String(putCalls[0][1]?.body))).toEqual({
      minGroupSize: 9,
      summerOnly: true,
      enabled: true,
    });

    // Back to read-only, showing the STORED values (4 / off), not the draft's.
    expect(
      screen.queryByRole("button", { name: "Save Group Discount" }),
    ).toBeNull();
    expect(minSizeInput().value).toBe("4");
    expect(
      (screen.getByLabelText("Summer seasons only") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(enabledBox().checked).toBe(true);
  });

  it("canEdit=false disables Edit and shows the view-only notice", async () => {
    hookMock.canEdit = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(LOADED), { status: 200 })),
    );
    await renderLoaded();

    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/cannot change it/i)).toBeTruthy();
  });

  it("canEdit=undefined (resolving) disables Edit and shows NO notice", async () => {
    hookMock.canEdit = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(LOADED), { status: 200 })),
    );
    await renderLoaded();

    expect(
      (screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByText(/cannot change it/i)).toBeNull();
  });
});
