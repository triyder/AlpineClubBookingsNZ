// @vitest-environment jsdom

import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VerifyStep } from "../google-wizard-steps";
import type { GoogleWizardContext } from "../use-google-wizard-context";
import type { WizardStepHelpers } from "@/components/admin/integration-wizard";

// The verify step reads `?googleVerifyError=1` (set by the signIn callback on a
// session-mismatch verify failure, src/lib/auth.ts) to surface a clear error.
const searchMock = vi.hoisted(() => ({ params: "" as string }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(searchMock.params),
}));

vi.mock("next-auth/react", () => ({ signIn: vi.fn() }));

function makeContext(
  overrides: Partial<GoogleWizardContext> = {},
): GoogleWizardContext {
  return {
    redirectUri: "https://example.test/api/auth/callback/google",
    legacyEnvVars: [],
    credentials: {
      client_id: { set: true, setAt: null },
      client_secret: { set: true, setAt: null },
    },
    isFullAdmin: true,
    needsReentry: false,
    verified: false,
    ...overrides,
  };
}

const helpers: WizardStepHelpers = {
  canEdit: true,
  refresh: vi.fn(),
  goNext: vi.fn(),
  isVerified: false,
  optional: false,
  acknowledged: false,
  skip: vi.fn(),
};

const ERROR_RE = /make sure you.re signed in as the same Full Admin/i;
const BOUNCE_RE = /bounce you to the login page with an error/i;

describe("VerifyStep verify-failure feedback (#2087)", () => {
  beforeEach(() => {
    searchMock.params = "";
  });
  afterEach(() => cleanup());

  it("renders the mismatch error Alert when googleVerifyError=1 and not verified", () => {
    searchMock.params = "googleVerifyError=1";
    render(<VerifyStep context={makeContext()} helpers={helpers} />);
    expect(screen.getByText(ERROR_RE)).toBeTruthy();
  });

  it("shows NO error Alert when the param is absent", () => {
    render(<VerifyStep context={makeContext()} helpers={helpers} />);
    expect(screen.queryByText(ERROR_RE)).toBeNull();
  });

  it("suppresses the error Alert once the round-trip has verified", () => {
    // A stale ?googleVerifyError=1 must not contradict a now-verified context.
    searchMock.params = "googleVerifyError=1";
    render(
      <VerifyStep context={makeContext({ verified: true })} helpers={helpers} />,
    );
    expect(screen.queryByText(ERROR_RE)).toBeNull();
    expect(screen.getByText(/round-trip completed successfully/i)).toBeTruthy();
  });

  it("amber guidance warns that wrong credentials/redirect URI bounce to the login page", () => {
    render(<VerifyStep context={makeContext()} helpers={helpers} />);
    expect(screen.getByText(BOUNCE_RE)).toBeTruthy();
  });
});
