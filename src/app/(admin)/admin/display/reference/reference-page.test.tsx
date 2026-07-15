// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import AdminDisplayReferencePage from "./page";
import { listDisplayModules } from "@/lib/lodge-display/module-registry";
import { listDisplayConditions } from "@/lib/lodge-display/conditions";
import { listDisplayCssTokens } from "@/lib/lodge-display/css-tokens";

// LTV-034 (#80): the reference page is read-only presentation over three
// client-safe registries. This is the light cross-registry sweep (mirroring the
// module-registry integrity idiom): every module, condition, and CSS token in
// the registries must appear on the page, so adding one to a registry surfaces
// it here without hand-maintained duplication. The live status fetch is stubbed;
// the static registry content renders independently of it.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/admin/lodges")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ lodges: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          lodgeId: "lodge-default",
          lodgeName: "Silverpeak Lodge",
          conditions: listDisplayConditions().map((c) => ({
            name: c.name,
            value: false,
          })),
        }),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Display reference page data sources", () => {
  it("renders every module, condition and CSS token from the registries", async () => {
    const { container } = render(<AdminDisplayReferencePage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const text = container.textContent ?? "";

    for (const mod of listDisplayModules()) {
      expect(text, `module "${mod.name}" missing`).toContain(mod.name);
      expect(text, `embed token for "${mod.name}" missing`).toContain(
        mod.embedToken
      );
    }
    for (const condition of listDisplayConditions()) {
      expect(text, `condition "${condition.name}" missing`).toContain(
        condition.name
      );
    }
    for (const token of listDisplayCssTokens()) {
      expect(text, `css token "${token.name}" missing`).toContain(token.name);
    }
  });

  it("shows the live indicator once the status endpoint responds", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/admin/lodges")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ lodges: [] }) });
      }
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            lodgeId: "lodge-default",
            lodgeName: "Silverpeak Lodge",
            conditions: [
              { name: "content:notice", value: true },
              { name: "occupancy:empty-today", value: false },
            ],
          }),
      });
    });

    const { container } = render(<AdminDisplayReferencePage />);
    await waitFor(() =>
      expect(container.textContent ?? "").toContain("Silverpeak Lodge")
    );
    expect(container.textContent ?? "").toContain("true now");
    expect(container.textContent ?? "").toContain("false now");
  });
});
