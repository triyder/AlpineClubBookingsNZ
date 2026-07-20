// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Profile "Connected accounts" control (#2035): Connect starts the OAuth
// round-trip (start route + signIn), Disconnect calls the unlink route, and the
// Connect affordance is gated on the module being on AND per-club credentials
// being configured — mirroring the login page.
const { mockSignIn } = vi.hoisted(() => ({ mockSignIn: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: mockSignIn }));

import { GoogleAccountCard } from "@/app/(authenticated)/profile/google-account-card";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GoogleAccountCard", () => {
  it("shows Connect and starts linking when the module is on and creds are configured", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    render(
      <GoogleAccountCard linked={false} moduleEnabled credentialsConfigured />,
    );

    fireEvent.click(screen.getByRole("button", { name: /connect google/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/profile/google/link/start",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(mockSignIn).toHaveBeenCalledWith("google", {
        callbackUrl: "/profile#security",
      }),
    );
  });

  it("hides Connect and explains when the module is on but credentials are missing", () => {
    render(
      <GoogleAccountCard
        linked={false}
        moduleEnabled
        credentialsConfigured={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /connect google/i }),
    ).toBeNull();
    expect(screen.getByText(/not yet configured by your club/i)).toBeTruthy();
  });

  it("hides Connect when the module is off", () => {
    render(
      <GoogleAccountCard
        linked={false}
        moduleEnabled={false}
        credentialsConfigured
      />,
    );
    expect(
      screen.queryByRole("button", { name: /connect google/i }),
    ).toBeNull();
    expect(screen.getByText(/turned off by your club/i)).toBeTruthy();
  });

  it("shows Disconnect for a linked member regardless of credential state", () => {
    render(
      <GoogleAccountCard
        linked
        moduleEnabled={false}
        credentialsConfigured={false}
      />,
    );
    expect(
      screen.getByRole("button", { name: /disconnect/i }),
    ).toBeTruthy();
  });
});
