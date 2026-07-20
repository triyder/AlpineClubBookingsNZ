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
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";

// Reference implementation of the canonical settings-section pattern (#2136).
// The hook suite covers the draft/snapshot mechanics; this covers THIS card's
// own wiring — which control writes which `setDraft` key, the `parseInt || 5`
// fallback, the `loading || !draft` early return, and the PUT body.

const ENDPOINT = "/api/admin/booking-policies/group-discount";

// `configured: true` is what the GET reports for a club with a persisted row
// (#2142); the synthesised no-row body reports `false` — see UNCONFIGURED below.
const LOADED = {
  minGroupSize: 6,
  summerOnly: true,
  enabled: false,
  configured: true,
};

// What the route synthesises when `findUnique` misses: the built-in defaults,
// flagged as not persisted.
const UNCONFIGURED = {
  id: "default",
  minGroupSize: 5,
  summerOnly: true,
  enabled: false,
  configured: false,
};

function enabledBox() {
  return screen.getByLabelText("Enabled") as HTMLInputElement;
}

function minSizeInput() {
  return screen.getByLabelText("Minimum group size") as HTMLInputElement;
}

function saveButton() {
  return screen.getByRole("button", {
    name: "Save Group Discount",
  }) as HTMLButtonElement;
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

  it("Save stays disabled while the draft is pristine, so a no-op never PUTs (#2143)", async () => {
    // The write route logs `group-discount.update` and revalidates the public
    // pages unconditionally, so an unchanged re-PUT would leave an audit entry
    // asserting a change that never happened.
    // Typed via a rest tuple so `mock.calls` still carries the `RequestInit`
    // this test filters on below, without declaring parameters it never reads.
    // The signature is declared on `vi.fn` rather than as parameters this test
    // never reads, so `mock.calls` still carries the `RequestInit` filtered on
    // below without tripping the unused-argument lint.
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify(LOADED), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(saveButton().disabled).toBe(true);

    // Dirtying the draft enables Save…
    fireEvent.click(enabledBox());
    expect(saveButton().disabled).toBe(false);

    // …and reverting it by hand disables Save again: the gate tracks the draft
    // against the snapshot, it is not a one-shot "has been touched" flag.
    fireEvent.click(enabledBox());
    expect(saveButton().disabled).toBe(true);

    // Belt and braces: even a forced click cannot reach the endpoint.
    fireEvent.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); // mount load only
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
    ).toHaveLength(0);
  });

  it("a club with NO persisted row can save the defaults as-is (#2142)", async () => {
    // The GET synthesises the defaults when there is no row, so draft === saved
    // from the first render. Gating Save on that comparison alone would leave an
    // admin who is happy with every default permanently unable to create the
    // row, and the setup checklist stuck on "using defaults" forever.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify({ id: "default", minGroupSize: 5, summerOnly: true, enabled: false }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(UNCONFIGURED), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText(/Group discount settings saved/i)).toBeTruthy(),
    );

    const putCalls = fetchMock.mock.calls.filter(
      ([, init]) => init?.method === "PUT",
    );
    expect(putCalls).toHaveLength(1);
    // `configured` is a client-side view of the GET, never part of the write.
    expect(JSON.parse(String(putCalls[0][1]?.body))).toEqual({
      minGroupSize: 5,
      summerOnly: true,
      enabled: false,
    });
  });

  it("after that first save the row exists, so a second pristine save is blocked (#2142/#2143)", async () => {
    // The PUT response is the row itself and carries no `configured` flag —
    // reaching it means the row now exists, so the escape hatch must close and
    // the ordinary #2143 dirty gate must take over.
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        return new Response(
          JSON.stringify({ id: "default", minGroupSize: 5, summerOnly: true, enabled: false }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(UNCONFIGURED), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(screen.getByText(/Group discount settings saved/i)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(saveButton().disabled).toBe(true);

    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "PUT"),
      ).toHaveLength(1),
    );
  });

  it("a FAILED load leaves Save gated, so it cannot blind-write the defaults (#2142)", async () => {
    // The failed-load fallback is the same defaults object, but we know nothing
    // about the stored row there. Treating it as "no row yet" would let a
    // pristine Save overwrite a real configured policy with the defaults.
    const fetchMock = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await renderLoaded();

    expect(screen.getByText(/Failed to fetch group discount/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(saveButton().disabled).toBe(true);
  });

  it("permissions narrowing mid-edit disables Save and explains it section-wide (#2142)", async () => {
    // The tri-state `useAdminAreaEditAccess` can flip after mount (a session
    // refetch narrowing the actor). Save must follow the Edit button's gating
    // rather than staying clickable into a 403.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(LOADED), { status: 200 })),
    );
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(enabledBox());
    expect(saveButton().disabled).toBe(false);

    // Narrow the actor, then re-render via a further draft edit.
    hookMock.canEdit = false;
    fireEvent.change(minSizeInput(), { target: { value: "9" } });

    expect(saveButton().disabled).toBe(true);
    // The reason is no longer hung off the button — a disabled button is out of
    // the tab order, so neither the title nor the described-by line was ever
    // reachable by keyboard or screen reader. The section banner says it once,
    // in the reading order, in a live region (#2142 owner decision).
    expect(saveButton().getAttribute("title")).toBeNull();
    expect(saveButton().getAttribute("aria-describedby")).toBeNull();
    // Queried by testid, not by role: `PolicyFeedback` now mounts its own
    // permanently-registered `role="status"` region for save confirmations, so
    // "the status region" is ambiguous (#2142 review).
    expect(
      screen.getByTestId("admin-view-only-banner").textContent,
    ).toContain(ADMIN_VIEW_ONLY_SECTION_HEADING);
  });

  it("canEdit=undefined mid-edit disables Save WITHOUT the view-only reason (#2142)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(LOADED), { status: 200 })),
    );
    await renderLoaded();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(enabledBox());

    // The resolving window is a NEUTRAL disabled state: no reason is flashed at
    // an admin who may well turn out to be edit-capable.
    hookMock.canEdit = undefined;
    fireEvent.change(minSizeInput(), { target: { value: "9" } });

    expect(saveButton().disabled).toBe(true);
    expect(saveButton().getAttribute("title")).toBeNull();
    expect(saveButton().getAttribute("aria-describedby")).toBeNull();
    // The live region itself is always mounted (#2142 review) — a polite region
    // must be registered before its content changes. What must be absent while
    // access is resolving is its CONTENT.
    expect(screen.getByTestId("admin-view-only-banner").textContent).toBe("");
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
