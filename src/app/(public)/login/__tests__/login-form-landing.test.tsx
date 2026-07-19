// @vitest-environment jsdom

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Post-login landing resolution on the credential form (#2090): after a
// successful sign-in the form asks the server where to land (preference / admin
// role default), then navigates there — via the 2FA detour when required, so
// the resolved landing survives the verify/enroll hop.
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

  it("materialises the resolved landing into the 2FA detour callbackUrl", async () => {
    mockFetch({
      "/api/auth/post-login-landing": { path: "/admin/dashboard" },
      "/api/auth/2fa/status": {
        required: true,
        verified: false,
        enrolled: true,
      },
    });

    renderForm();
    await submit();

    await waitFor(() =>
      expect(assignMock).toHaveBeenCalledWith(
        "/login/verify?callbackUrl=%2Fadmin%2Fdashboard",
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
