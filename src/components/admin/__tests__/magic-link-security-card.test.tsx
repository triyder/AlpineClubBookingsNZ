// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODULE_SETTINGS } from "@/config/modules";
import { MagicLinkSecurityCard } from "@/components/admin/magic-link-security-card";

// Self-contained Login & Security card (#2034). The enable toggle persists the
// magicLink module column through the existing PUT /api/admin/modules route.
describe("MagicLinkSecurityCard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reflects the current module state and renders the TTL field", () => {
    render(
      <MagicLinkSecurityCard
        moduleSettings={{ ...DEFAULT_MODULE_SETTINGS, magicLink: true }}
      />,
    );

    const toggle = screen.getByRole("checkbox", {
      name: /enable email sign-in link/i,
    });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(screen.getByLabelText(/link expiry/i)).toBeTruthy();
  });

  it("persists the enable toggle through PUT /api/admin/modules with the full settings", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    render(
      <MagicLinkSecurityCard
        moduleSettings={{ ...DEFAULT_MODULE_SETTINGS, magicLink: false }}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", { name: /enable email sign-in link/i }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/modules");
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body));
    expect(body.settings.magicLink).toBe(true);
    // Sends the whole settings object (the route's schema is strict).
    expect(Object.keys(body.settings).sort()).toEqual(
      Object.keys(DEFAULT_MODULE_SETTINGS).sort(),
    );
  });
});
