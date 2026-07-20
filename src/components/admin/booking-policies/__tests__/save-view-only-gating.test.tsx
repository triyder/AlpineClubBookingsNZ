// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hookMock = vi.hoisted(() => ({ canEdit: true as boolean | undefined }));
vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => hookMock.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

// Single-lodge club: `PolicyScopeSelect` renders nothing below two lodges, so
// these suites exercise the club-wide scope only — which is all the Save gating
// depends on.
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: [], loading: false }),
}));

import { BookingPeriodsSection } from "../booking-periods-section";
import { DefaultCancellationPolicySection } from "../default-cancellation-policy-section";
import { MinimumNightStaySection } from "../minimum-night-stay-section";
import { PublicBookingRequestsSection } from "../public-booking-requests-section";

// #2142: every booking-policies section's Save is wrapped in
// `ViewOnlyActionButton`, matching the security cards and the sections' own
// Edit/Add buttons. The interesting case is the tri-state
// `useAdminAreaEditAccess` flipping AFTER the form was opened — a session
// refetch narrowing the actor mid-edit. Before this change Save stayed
// clickable in that window and the admin walked into a 403.
//
// Each section is hand-rolled (they do not use `useSectionEditState`), so these
// assertions are per-section rather than delegated to the hook suite.

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Narrow the actor and force a re-render through a real form interaction. */
function narrowTo(canEdit: boolean | undefined, rerenderBy: () => void) {
  hookMock.canEdit = canEdit;
  rerenderBy();
}

function expectViewOnly(button: HTMLButtonElement) {
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("title")).toBe("View-only reason");
  const describedBy = button.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(String(describedBy))?.textContent).toBe(
    "View-only reason",
  );
}

function expectNeutralDisabled(button: HTMLButtonElement) {
  // The resolving (`undefined`) window must not flash the read-only reason at
  // an admin who may well turn out to be edit-capable.
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("title")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBeNull();
}

beforeEach(() => {
  hookMock.canEdit = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BookingPeriodsSection Save gating (#2142)", () => {
  async function openForm() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([])),
    );
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Period" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Period" }));
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-07-14" },
    });
  }

  function createButton() {
    return screen.getByRole("button", {
      name: "Create Period",
    }) as HTMLButtonElement;
  }

  it("enables Create Period for an edit-capable admin", async () => {
    await openForm();
    expect(createButton().disabled).toBe(false);
  });

  it("disables Create Period when the actor is narrowed mid-edit", async () => {
    await openForm();
    narrowTo(false, () =>
      fireEvent.change(screen.getByLabelText("Period Name"), {
        target: { value: "School Holidays 2" },
      }),
    );
    expectViewOnly(createButton());
  });

  it("disables Create Period neutrally while access is resolving", async () => {
    await openForm();
    narrowTo(undefined, () =>
      fireEvent.change(screen.getByLabelText("Period Name"), {
        target: { value: "School Holidays 2" },
      }),
    );
    expectNeutralDisabled(createButton());
  });
});

describe("MinimumNightStaySection Save gating (#2142)", () => {
  async function openForm() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse([])),
    );
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Policy" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Policy" }));
    fireEvent.change(screen.getByLabelText("Policy Name"), {
      target: { value: "Winter Saturdays" },
    });
    fireEvent.change(screen.getByLabelText("Start Date"), {
      target: { value: "2026-07-01" },
    });
    fireEvent.change(screen.getByLabelText("End Date"), {
      target: { value: "2026-09-30" },
    });
  }

  function createButton() {
    return screen.getByRole("button", {
      name: "Create Policy",
    }) as HTMLButtonElement;
  }

  it("enables Create Policy for an edit-capable admin", async () => {
    await openForm();
    expect(createButton().disabled).toBe(false);
  });

  it("disables Create Policy when the actor is narrowed mid-edit", async () => {
    await openForm();
    narrowTo(false, () =>
      fireEvent.change(screen.getByLabelText("Policy Name"), {
        target: { value: "Winter Saturdays 2" },
      }),
    );
    expectViewOnly(createButton());
  });

  it("disables Create Policy neutrally while access is resolving", async () => {
    await openForm();
    narrowTo(undefined, () =>
      fireEvent.change(screen.getByLabelText("Policy Name"), {
        target: { value: "Winter Saturdays 2" },
      }),
    );
    expectNeutralDisabled(createButton());
  });
});

describe("DefaultCancellationPolicySection Save gating (#2142)", () => {
  const LOADED = {
    rules: [
      {
        daysBeforeStay: 14,
        refundPercentage: 100,
        creditRefundPercentage: 100,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ],
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 7,
  };

  async function startEditing() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(LOADED)),
    );
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  }

  function saveButton() {
    return screen.getByRole("button", {
      name: "Save Default Policy",
    }) as HTMLButtonElement;
  }

  function bumpHoldDays(value: string) {
    fireEvent.change(
      screen.getByLabelText("Non-member confirmation threshold"),
      { target: { value } },
    );
  }

  it("enables Save Default Policy for an edit-capable admin", async () => {
    await startEditing();
    expect(saveButton().disabled).toBe(false);
  });

  it("disables Save Default Policy when the actor is narrowed mid-edit", async () => {
    await startEditing();
    narrowTo(false, () => bumpHoldDays("9"));
    expectViewOnly(saveButton());
  });

  it("disables Save Default Policy neutrally while access is resolving", async () => {
    await startEditing();
    narrowTo(undefined, () => bumpHoldDays("9"));
    expectNeutralDisabled(saveButton());
  });
});

describe("PublicBookingRequestsSection Save gating (#2142)", () => {
  const LOADED = {
    showPricingToNonMembers: false,
    quoteResponseTtlDays: 14,
    quoteReminderLeadDays: 3,
    attendeeConfirmationLeadDays: 14,
    attendeeConfirmationReminderDays: 3,
  };

  // This section was already gated correctly on `!canEdit` by hand, so these
  // are not correctness fixes — they pin the a11y affordance the raw <button>
  // could not carry (`title` + `aria-describedby` + the sr-only reason), which
  // is what "unified" in #2142 actually means. Its own dirty tracking
  // (`timingDirty` / `attendeeTimingDirty`) is preserved untouched.
  async function loadSection() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(LOADED)),
    );
    render(<PublicBookingRequestsSection />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save quote timing" }),
      ).toBeTruthy(),
    );
  }

  function quoteButton() {
    return screen.getByRole("button", {
      name: "Save quote timing",
    }) as HTMLButtonElement;
  }

  function attendeeButton() {
    return screen.getByRole("button", {
      name: "Save attendee prompts",
    }) as HTMLButtonElement;
  }

  function dirtyQuoteTiming(value: string) {
    fireEvent.change(screen.getByLabelText("Quote response window (days)"), {
      target: { value },
    });
  }

  function dirtyAttendeeTiming(value: string) {
    fireEvent.change(
      screen.getByLabelText("First prompt (days before check-in)"),
      { target: { value } },
    );
  }

  it("keeps both Saves disabled while pristine", async () => {
    await loadSection();
    expect(quoteButton().disabled).toBe(true);
    expect(attendeeButton().disabled).toBe(true);
  });

  it("enables each Save independently once its own fields are dirty", async () => {
    await loadSection();
    dirtyQuoteTiming("20");
    expect(quoteButton().disabled).toBe(false);
    // The two cards track dirtiness separately; one must not enable the other.
    expect(attendeeButton().disabled).toBe(true);

    dirtyAttendeeTiming("21");
    expect(attendeeButton().disabled).toBe(false);
  });

  it("disables both Saves with the spoken reason when the actor is narrowed mid-edit", async () => {
    await loadSection();
    dirtyQuoteTiming("20");
    dirtyAttendeeTiming("21");
    expect(quoteButton().disabled).toBe(false);

    narrowTo(false, () => dirtyQuoteTiming("21"));

    expectViewOnly(quoteButton());
    expectViewOnly(attendeeButton());
  });

  it("disables both Saves neutrally while access is resolving", async () => {
    await loadSection();
    dirtyQuoteTiming("20");
    dirtyAttendeeTiming("21");

    narrowTo(undefined, () => dirtyQuoteTiming("21"));

    expectNeutralDisabled(quoteButton());
    expectNeutralDisabled(attendeeButton());
  });
});
