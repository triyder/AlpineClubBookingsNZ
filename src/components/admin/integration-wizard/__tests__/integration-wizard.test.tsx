// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// Per-test persisted cursor; null = fresh run (no saved progress).
let mockedProgress: {
  currentStepId?: string;
  completedStepIds?: string[];
} | null = null;

beforeEach(() => {
  mockedProgress = null;
  // Cursor GET returns the configured persisted progress; POST is a no-op success.
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return {
        ok: true,
        json: async () => ({ wizardId: "test", progress: mockedProgress }),
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
  it("starts a FIRST run at step one even when it verifies trivially", async () => {
    // Step A is an always-verified instructions step; without a persisted
    // cursor the wizard must still open on it, not auto-advance past the
    // guide (the #2080 E2E caught exactly this).
    renderWizard({ bReady: false, cReady: false });
    await waitFor(() => {
      expect(screen.getByText("Step A body")).toBeTruthy();
    });
  });

  it("resumes at the persisted cursor, clamped to the reachable range", async () => {
    mockedProgress = { currentStepId: "b" };
    renderWizard({ bReady: false, cReady: false });
    await waitFor(() => {
      expect(screen.getByText("Step B body")).toBeTruthy();
    });
  });

  it("gates Continue on the current step verifying", async () => {
    const { rerender } = renderWizard({ bReady: false, cReady: false });

    // Fresh run opens on A; B is reachable (A verified) — walk forward to it.
    await waitFor(() => screen.getByText("Step A body"));
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
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

  it("uses provider completion copy when supplied (never 'the whole thing is done')", async () => {
    render(
      <IntegrationWizard<Ctx>
        wizardId="test"
        title="Test wizard"
        steps={steps()}
        context={{ bReady: true, cReady: true }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
        completion={{
          badgeLabel: "Connected",
          message: "Connected",
          hint: "Configure mappings below to finish.",
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Configure mappings below/i)).toBeTruthy();
    });
    expect(screen.queryByText(/Setup complete/i)).toBeNull();
  });
});

interface OptCtx {
  bVerified: boolean;
}

function optionalSteps(): WizardStepConfig<OptCtx>[] {
  return [
    {
      id: "a",
      title: "Step A",
      isVerified: () => true,
      render: () => <div>Step A body</div>,
    },
    {
      id: "b",
      title: "Step B",
      // Optional + unverified ⇒ skippable via the shell's skip action.
      optional: { skipLabel: "Skip B for now", skipDescription: "Do it later." },
      isVerified: (ctx) => ctx.bVerified,
      render: () => <div>Step B body</div>,
    },
    {
      id: "c",
      title: "Step C",
      isVerified: () => true,
      render: () => <div>Step C body</div>,
    },
  ];
}

function renderOptional(context: OptCtx, steps = optionalSteps()) {
  return render(
    <IntegrationWizard<OptCtx>
      wizardId="test"
      title="Test wizard"
      steps={steps}
      context={context}
      contextLoading={false}
      onRefresh={() => {}}
      canEdit={true}
      viewOnlyBanner={<>view only</>}
    />,
  );
}

describe("IntegrationWizard optional-step skip (#2080 UX-F1)", () => {
  it("skips an optional unverified step, which advances past the gate", async () => {
    renderOptional({ bVerified: false });

    // Fresh run opens on A; walk to the optional step B, which is gated
    // (Continue is not offered on an unpassed non-last step) but offers
    // the shell's provider-labelled skip action.
    await waitFor(() => screen.getByText("Step A body"));
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
    await waitFor(() => {
      expect(screen.getByText("Step B body")).toBeTruthy();
    });
    const skip = screen.getByRole("button", { name: "Skip B for now" });
    expect(skip).toBeTruthy();

    fireEvent.click(skip);

    // Skipping acknowledges B and advances to C (now reachable).
    await waitFor(() => {
      expect(screen.getByText("Step C body")).toBeTruthy();
    });
    // The skipped step is marked "Skipped for now" in the stepper (amber state).
    expect(screen.getByText(/Skipped for now/i)).toBeTruthy();
  });

  it("clears the skipped (amber) state once the step later verifies", async () => {
    const { rerender } = renderOptional({ bVerified: false });
    await waitFor(() => screen.getByText("Step A body"));
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
    await waitFor(() => screen.getByText("Step B body"));
    fireEvent.click(screen.getByRole("button", { name: "Skip B for now" }));
    await waitFor(() => expect(screen.getByText(/Skipped for now/i)).toBeTruthy());

    // B now verifies (verified > acknowledged): the amber "skipped" note clears.
    rerender(
      <IntegrationWizard<OptCtx>
        wizardId="test"
        title="Test wizard"
        steps={optionalSteps()}
        context={{ bVerified: true }}
        contextLoading={false}
        onRefresh={() => {}}
        canEdit={true}
        viewOnlyBanner={<>view only</>}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText(/Skipped for now/i)).toBeNull();
    });
  });

  it("never offers a skip action for a required unverified step", async () => {
    // Reuse the standard steps() where B is required + unverified.
    renderWizard({ bReady: false, cReady: false });
    await waitFor(() => screen.getByText("Step A body"));
    fireEvent.click(screen.getByRole("button", { name: /Step B/ }));
    await waitFor(() => screen.getByText("Step B body"));
    expect(screen.queryByRole("button", { name: /skip/i })).toBeNull();
  });
});

describe("IntegrationWizard focus management (#2080 UX-F3)", () => {
  it("does not steal focus on the initial resume render", async () => {
    mockedProgress = { currentStepId: "c" };
    renderOptional({ bVerified: true });
    await waitFor(() => screen.getByText("Step C body"));
    // Focus was not yanked to the step container on mount.
    expect((document.activeElement as HTMLElement)?.tagName).not.toBe(
      undefined,
    );
    expect(document.activeElement).toBe(document.body);
  });

  it("moves focus to the new step container on a step change", async () => {
    mockedProgress = { currentStepId: "c" };
    renderOptional({ bVerified: true });
    await waitFor(() => screen.getByText("Step C body"));

    // Jump to Step A via its (reachable) stepper button.
    fireEvent.click(screen.getByRole("button", { name: /Step A/ }));

    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.getAttribute("tabindex")).toBe("-1");
      expect(active?.textContent).toContain("Step A body");
    });
  });
});
