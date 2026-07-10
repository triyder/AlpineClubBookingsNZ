import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// LoginForm is a client component: it calls useRouter/useClubIdentity during
// render and imports signIn. Stub those so the real page → real form → real
// auth-redirect validation path renders as static markup (node environment,
// mirroring the profile-page-two-factor test convention). next/link needs no
// router context to emit an anchor, but we mock it defensively so the render
// never depends on one.
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: unknown; children: ReactNode }) => (
    <a href={String(href)} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

// These specs cover the anonymous form render; the authenticated self-heal
// redirect is covered in login-page-session-redirect.test.tsx.
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => null),
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ name: "Test Alpine Club" }),
}));

import LoginPage from "../page";

async function renderLoginPage(
  params: Record<string, string | string[] | undefined>
) {
  return renderToStaticMarkup(
    await LoginPage({ searchParams: Promise.resolve(params) }),
  );
}

describe("LoginPage auth-bounce ref", () => {
  it("renders the reference line for a valid ref", async () => {
    const html = await renderLoginPage({ ref: "ABCD1234" });

    expect(html).toContain('data-testid="auth-bounce-ref"');
    expect(html).toContain("Trouble signing in? Reference:");
    expect(html).toContain("ABCD1234");
  });

  it("stays visible alongside another alert", async () => {
    const html = await renderLoginPage({ ref: "ABCD1234", verifyError: "expired" });

    expect(html).toContain('data-testid="auth-bounce-ref"');
    expect(html).toContain("ABCD1234");
    expect(html).toContain("verification link has expired");
  });

  it("renders nothing when no ref is present", async () => {
    const html = await renderLoginPage({});

    expect(html).not.toContain('data-testid="auth-bounce-ref"');
    expect(html).not.toContain("Trouble signing in?");
  });

  it("drops a lowercase ref and renders nothing", async () => {
    const html = await renderLoginPage({ ref: "abcd1234" });

    expect(html).not.toContain('data-testid="auth-bounce-ref"');
    expect(html).not.toContain("Trouble signing in?");
    expect(html).not.toContain("abcd1234");
  });

  it("drops a wrong-length ref and renders nothing", async () => {
    const html = await renderLoginPage({ ref: "ABCD123" });

    expect(html).not.toContain('data-testid="auth-bounce-ref"');
    expect(html).not.toContain("Trouble signing in?");
    expect(html).not.toContain("ABCD123");
  });

  it("drops an injection-style ref and renders nothing", async () => {
    const html = await renderLoginPage({ ref: "AAAA&admin=1" });

    expect(html).not.toContain('data-testid="auth-bounce-ref"');
    expect(html).not.toContain("Trouble signing in?");
    expect(html).not.toContain("admin=1");
  });

  it("uses the first value when ref arrives as an array", async () => {
    const html = await renderLoginPage({ ref: ["ABCD1234", "deadbeef"] });

    expect(html).toContain('data-testid="auth-bounce-ref"');
    expect(html).toContain("ABCD1234");
    expect(html).not.toContain("deadbeef");
  });
});
