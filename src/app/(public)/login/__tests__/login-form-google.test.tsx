// @vitest-environment jsdom

import { render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Google sign-in surface on the login form (#2035): the "Continue with Google"
// button appears only when enabled, and OAuth refusals redirected as ?error=…
// render a visible, friendly message (the planning-review MAJOR: previously
// unwired for OAuth).
const { mockSignIn } = vi.hoisted(() => ({ mockSignIn: vi.fn() }));
vi.mock("next-auth/react", () => ({ signIn: mockSignIn }));
vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Club" }),
}));

import { LoginForm } from "@/app/(public)/login/login-form";

function renderForm(props: Partial<React.ComponentProps<typeof LoginForm>> = {}) {
  return render(
    <LoginForm
      verified={false}
      emailChanged={false}
      redirectTo="/dashboard"
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("LoginForm — Google button", () => {
  it("starts the OAuth flow returning to /login for server-side landing resolution (#2090)", () => {
    // With no explicit deep link, Google returns to /login, whose authenticated
    // self-heal resolves the member's landing preference / admin role default.
    renderForm({ googleLoginEnabled: true });
    const button = screen.getByRole("button", { name: /continue with google/i });
    fireEvent.click(button);
    expect(mockSignIn).toHaveBeenCalledWith("google", {
      callbackUrl: "/login",
    });
  });

  it("returns straight to a genuinely explicit deep link when one is present (#2090)", () => {
    renderForm({
      googleLoginEnabled: true,
      explicitCallbackUrl: "/nominations/tok-1",
    });
    fireEvent.click(
      screen.getByRole("button", { name: /continue with google/i }),
    );
    expect(mockSignIn).toHaveBeenCalledWith("google", {
      callbackUrl: "/nominations/tok-1",
    });
  });

  it("hides the button when disabled", () => {
    renderForm({ googleLoginEnabled: false });
    expect(
      screen.queryByRole("button", { name: /continue with google/i }),
    ).toBeNull();
  });
});

describe("LoginForm — OAuth error surfacing", () => {
  it.each([
    ["google_unlinked", /isn't linked/i],
    ["google_password_change", /password update is required/i],
    ["google_disabled", /currently turned off/i],
    ["google_refused", /couldn't sign you in with google/i],
    ["something_else", /could not sign in with google/i],
  ])("renders a friendly message for error=%s", (error, matcher) => {
    renderForm({ oauthError: error });
    expect(screen.getByText(matcher)).toBeTruthy();
  });

  it("shows no OAuth error when none is present", () => {
    renderForm();
    expect(screen.queryByText(/google/i)).toBeNull();
  });
});
