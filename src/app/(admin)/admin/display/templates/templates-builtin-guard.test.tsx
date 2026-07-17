// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// #1940: the page reads the session permission matrix for view-only gating;
// provide an edit-level admin session so the built-in guard cases keep working.
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

import AdminDisplayTemplatesPage from "./page";

// Fork issue #156: editing a built-in Template (`everyday-board` etc.) in place
// is overwritten on the next re-seed/upgrade (#111 refresh-from-code contract).
// The editor must show a persistent notice with a one-click Duplicate action and
// require an explicit confirmation before saving an in-place built-in edit.

const BUILT_IN_ROW = {
  id: "builtin-template-everyday-board",
  key: "everyday-board",
  name: "Everyday board",
  layout: { id: "builtin-layout-everyday-board", key: "everyday-board", name: "Everyday board" },
  deviceCount: 1,
  updatedAt: "2026-07-15T00:00:00.000Z",
};

/** Full authored template the GET /templates/[id] route returns. */
const BUILT_IN_FULL = {
  id: BUILT_IN_ROW.id,
  key: BUILT_IN_ROW.key,
  name: BUILT_IN_ROW.name,
  layout: {
    id: BUILT_IN_ROW.layout.id,
    name: BUILT_IN_ROW.layout.name,
    areas: [{ key: "main", description: "The board", kind: "static" }],
  },
  slotContent: { main: { module: "arrivals-board", options: { days: 3 } } },
  cssOverrides: "",
  footerHtml: "<p>Have a nice day</p>",
};

function installFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (url === "/api/admin/display/templates" && method === "GET") {
      return json({ templates: [BUILT_IN_ROW] });
    }
    if (url === "/api/admin/display/layouts" && method === "GET") {
      return json({ layouts: [BUILT_IN_ROW.layout] });
    }
    if (url === "/api/admin/lodges" && method === "GET") {
      return json({ lodges: [{ id: "lodge-a", name: "Ruapehu Lodge", active: true }] });
    }
    if (url === `/api/admin/display/templates/${BUILT_IN_ROW.id}` && method === "GET") {
      return json({ template: BUILT_IN_FULL });
    }
    if (url === `/api/admin/display/templates/${BUILT_IN_ROW.id}` && method === "PUT") {
      return json({ template: { id: BUILT_IN_ROW.id, key: BUILT_IN_ROW.key, name: BUILT_IN_ROW.name }, warnings: [] });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function openBuiltIn() {
  render(<AdminDisplayTemplatesPage />);
  const editButton = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(editButton);
  await screen.findByText("This is a built-in template.");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AdminDisplayTemplatesPage — built-in guard", () => {
  beforeEach(() => {
    installFetch();
  });

  it("shows the persistent not-upgrade-safe notice when a built-in is opened", async () => {
    await openBuiltIn();
    expect(screen.getByText(/overwritten/i)).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Duplicate to customise" })
    ).toBeDefined();
  });

  it("Duplicate forks to a new custom template (notice clears, key suffixed)", async () => {
    await openBuiltIn();
    fireEvent.click(
      screen.getByRole("button", { name: "Duplicate to customise" })
    );
    await waitFor(() =>
      expect(screen.queryByText("This is a built-in template.")).toBeNull()
    );
    const keyInput = screen.getByLabelText("Key") as HTMLInputElement;
    expect(keyInput.value).toBe("everyday-board-copy");
    expect(screen.getByRole("button", { name: "Create template" })).toBeDefined();
  });

  it("requires confirmation before saving an in-place built-in edit; cancel blocks the PUT", async () => {
    const { calls } = installFetch();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<AdminDisplayTemplatesPage />);
    const editButton = await screen.findByRole("button", { name: "Edit" });
    fireEvent.click(editButton);
    await screen.findByText("This is a built-in template.");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toMatch(/not upgrade-safe/i);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(
      calls.some(
        (c) => c.method === "PUT" && c.url.includes("/api/admin/display/templates/")
      )
    ).toBe(false);
  });

  it("confirming the built-in save sends the PUT", async () => {
    const { calls } = installFetch();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminDisplayTemplatesPage />);
    const editButton = await screen.findByRole("button", { name: "Edit" });
    fireEvent.click(editButton);
    await screen.findByText("This is a built-in template.");

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.method === "PUT" &&
            c.url === `/api/admin/display/templates/${BUILT_IN_ROW.id}`
        )
      ).toBe(true)
    );
  });
});
