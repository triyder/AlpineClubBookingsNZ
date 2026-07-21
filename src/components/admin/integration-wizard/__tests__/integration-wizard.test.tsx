// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationWizard } from "../integration-wizard";
import type { WizardStepConfig } from "../types";

interface Ctx {
  bReady: boolean;
  cReady: boolean;
}

function steps(): WizardStepConfig<Ctx>[] {
  return [
    {
      id: "a",
      title: "Step A",
      isVerified: () => true, // instructions step — never blocks
      render: () => <div>Step A body</div>,
    },
    {
      id: "b",
      title: "Step B",
      isVerified: (ctx) => ctx.bReady,
      render: () => <div>Step B body</div>,
    },
    {
      id: "c",
      title: "Step C",
      isVerified: (ctx) => ctx.cReady,
      render: () => <div>Step C body</div>,
    },
  ];
}

beforeEach(() => {
  // Cursor GET returns no persisted progress; POST is a no-op success.
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return {
        ok: true,
        json: async () => ({ wizardId: "test", progress: null }),
      } as Response;
    }
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderWizard(context: Ctx) {
  return render(
    <IntegrationWizard<Ctx>
      wizardId="test"
      title="Test wizard"
      steps={steps()}
      context={context}
      contextLoading={false}
      onRefresh={() => {}}
      canEdit={true}
      viewOnlyBanner={<>view only</>}
    />,
  );
}

describe("IntegrationWizard gating (#2080)", () => {
  it("resumes at the first unverified step and blocks Continue until it verifies", async () => {
    const { rerender } = renderWizard({ bReady: false, cReady: false });

    // Step A is verified (instructions), so the furthest reachable step is B —
    // the wizard resumes there, and Continue is blocked because B is unverified.
    await waitFor(() => {
      expect(screen.getByText("Step B body")).toBeTruthy();
    });
    const continueBtn = screen.getByRole("button", { name: "Continue" });
    expect((continueBtn as HTMLButtonElement).disabled).toBe(true);

    // The gated step C is not reachable yet (its stepper entry is disabled).
    const stepCButton = screen.getByRole("button", { name: /Step C/ });
    expect((stepCButton as HTMLButtonElement).disabled).toBe(true);

    // Once B verifies, Continue enables.
    rerender(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={steps()}
        context={{ bReady: true, cReady: false }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
      />,
    );
    await waitFor(() => {
      expect(
        (screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
  });

  it("shows the completion state when every step is verified", async () => {
    renderWizard({ bReady: true, cReady: true });
    await waitFor(() => {
      expect(screen.getByText(/Setup complete/i)).toBeTruthy();
    });
  });
});
