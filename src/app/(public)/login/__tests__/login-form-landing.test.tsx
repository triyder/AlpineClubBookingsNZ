// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Post-login landing resolution on the credential form (#2090): after a
// successful sign-in the form checks the 2FA gate first. When a challenge is
// open it hands off to the verify/enroll detour (which re-resolves the default
// landing server-side, so the detour carries only a genuine explicit deep link);
// otherwise it asks the server where to land (preference / admin role default)
// and navigates straight there.
const { mockSignIn } = vi.hoisted(() => ({ mockSignIn: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: mockSignIn }));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));

import { LoginForm } from "@/app/(public)/login/login-form";

function renderForm(
  props: Partial<React.ComponentProps<typeof LoginForm>> = {},
) {
  return render(
    <LoginForm
      verified={false}
      emailChanged={false}
      redirectTo="/dashboard"
      {...props}
    />,
  );
}

async function submit() {
  fireEvent.change(screen.getByLabelText(/email/i), {
    target: { value: "admin@example.com" },
  });
  fireEvent.change(screen.getByLabelText(/password/i), {
    target: { value: "pw" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^sign in$/i }));
}

const assignMock = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  vi.clearAllMocks();
  mockSignIn.mockResolvedValue({ error: undefined });
  // jsdom's window.location.assign is non-configurable, so replace the whole
  // location object with a minimal stub (the form only ever calls .assign).
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { assign: assignMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetch(handlers: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const key = Object.keys(handlers).find((k) => url.startsWith(k));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(key ? handlers[key] : {}),
      } as Response);
    }),
  );
}

describe("LoginForm — post-auth landing navigation (#2090)", () => {
  it("navigates to the resolved landing when no 2FA is required", async () => {
    mockFetch({
      "/api/auth/post-login-landing": { path: "/admin/dashboard" },
      "/api/auth/2fa/status": { required: false },
    });

    renderForm();
    await submit();

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/admin/dashboard"));
  });

  it("hands off to the 2FA detour WITHOUT baking a default landing into it", async () => {
    // Determinism (#2090): with no explicit deep link, the detour carries no
    // callbackUrl at all — the default landing is re-resolved server-side at
    // /login/verify, so a raced/failed post-signIn resolver can never strand an
    // admin-access member on /dashboard.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.startsWith("/api/auth/2fa/status")
        ? { required: true, verified: false, enrolled: true }
        : { path: "/admin/dashboard" };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderForm();
    await submit();

    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith("/login/verify"),
    );
    // The landing resolver is never consulted on the detour path — the detour
    // page owns the resolution, so there is nothing to race.
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/auth/post-login-landing"),
      ),
    ).toBe(false);
  });

  it("carries a genuinely explicit deep link into the 2FA detour callbackUrl", async () => {
    // An explicit deep link must survive the detour so it can win post-verify
    // (D-D4). Only genuine deep links are ever written to the detour callbackUrl.
    mockFetch({
      "/api/auth/2fa/status": {
        required: true,
        verified: false,
        enrolled: false,
      },
    });

    renderForm({ explicitCallbackUrl: "/nominations/tok" });
    await submit();

    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        "/login/enroll?callbackUrl=%2Fnominations%2Ftok",
      ),
    );
  });

  it("passes an abort signal to the resolver fetch so a hung request times out", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.startsWith("/api/auth/post-login-landing")
        ? { path: "/admin/dashboard" }
        : { required: false };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderForm();
    await submit();

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/admin/dashboard"));
    const resolverCall = fetchMock.mock.calls.find(([input]) =>
      String(input).startsWith("/api/auth/post-login-landing"),
    );
    expect(resolverCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards a genuinely explicit callbackUrl to the resolver", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const body = url.startsWith("/api/auth/post-login-landing")
        ? { path: "/nominations/tok" }
        : { required: false };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderForm({ explicitCallbackUrl: "/nominations/tok" });
    await submit();

    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/nominations/tok"));
    // The explicit deep link is passed through as the callbackUrl query param.
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith(
          "/api/auth/post-login-landing?callbackUrl=%2Fnominations%2Ftok",
        ),
      ),
    ).toBe(true);
  });
});
