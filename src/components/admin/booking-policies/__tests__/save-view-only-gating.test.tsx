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
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";

// #2142: every booking-policies section's Save is wrapped in
// `ViewOnlyActionButton`, matching the security cards and the sections' own
// Edit/Add buttons. The interesting case is the tri-state
// `useAdminAreaEditAccess` flipping AFTER the form was opened — a session
// refetch narrowing the actor mid-edit. Before this change Save stayed
// clickable in that window and the admin walked into a 403.
//
// The EXPLANATION for that disabled state is now section-level: these five
// sections render one `AdminViewOnlySectionBanner` and pass
// `describeReason={false}` to every button, because a disabled button is out of
// the tab order and so its `title` / `aria-describedby` were unreachable by
// exactly the keyboard and screen-reader users they were meant for.
//
// #2143: the three formerly hand-rolled sections now track draft-vs-snapshot
// dirtiness through `useSectionEditState`, so an Edit -> Save that changed
// nothing cannot reach a write route that logs an audit entry unconditionally.

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Narrow the actor and force a re-render.
 *
 * `useAdminAreaEditAccess` reads the client session, so in the real app a
 * mid-edit narrowing re-renders the SECTION (the hook's own state changed) and
 * the new `canEdit` flows down to every button, including the ones inside the
 * open editor sub-component. The module-level mock here cannot push a render on
 * its own, so the caller supplies one: either RTL's `rerender` (the faithful
 * stand-in for a section re-render) or, for sections that own their field state
 * directly, a real form interaction.
 */
function narrowTo(canEdit: boolean | undefined, rerenderBy: () => void) {
  hookMock.canEdit = canEdit;
  rerenderBy();
}

function expectViewOnly(button: HTMLButtonElement) {
  expect(button.disabled).toBe(true);
  // The reason is NOT hung off the button any more (#2142 owner decision) …
  expect(button.getAttribute("title")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBeNull();
  // … it is announced once, in the reading order, by the section banner.
  const banner = screen.getByRole("status");
  expect(banner.textContent).toContain(ADMIN_VIEW_ONLY_SECTION_HEADING);
}

function expectNeutralDisabled(button: HTMLButtonElement) {
  // The resolving (`undefined`) window must not flash the read-only reason at
  // an admin who may well turn out to be edit-capable.
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("title")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBeNull();
  expect(screen.queryByRole("status")).toBeNull();
}

/** Every write verb the section could have fired, across the whole stub. */
function writeCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method !== undefined,
  );
}

beforeEach(() => {
  hookMock.canEdit = true;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BookingPeriodsSection Save gating (#2142, #2143)", () => {
  const PERIOD = {
    id: "p1",
    name: "School Holidays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-14T00:00:00.000Z",
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 5,
    cancellationRules: [
      {
        daysBeforeStay: 21,
        refundPercentage: 100,
        creditRefundPercentage: 100,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ],
    active: true,
  };

  function stub(list: unknown[] = []) {
    const fetchMock = vi.fn(async () => jsonResponse(list));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function openForm() {
    stub([]);
    const { rerender } = render(<BookingPeriodsSection />);
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
    return () => rerender(<BookingPeriodsSection />);
  }

  async function openExistingPeriod() {
    const fetchMock = stub([PERIOD]);
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return fetchMock;
  }

  function createButton() {
    return screen.getByRole("button", {
      name: "Create Period",
    }) as HTMLButtonElement;
  }

  function updateButton() {
    return screen.getByRole("button", {
      name: "Update Period",
    }) as HTMLButtonElement;
  }

  it("enables Create Period for an edit-capable admin", async () => {
    await openForm();
    expect(createButton().disabled).toBe(false);
  });

  it("disables Create Period when the actor is narrowed mid-edit", async () => {
    const rerender = await openForm();
    narrowTo(false, rerender);
    expectViewOnly(createButton());
  });

  it("disables Create Period neutrally while access is resolving", async () => {
    const rerender = await openForm();
    narrowTo(undefined, rerender);
    expectNeutralDisabled(createButton());
  });

  // #2143: `periods/[id]` PUT writes a `booking-period.update` audit entry with
  // a before/after pair unconditionally, so a pristine Update would record a
  // change that never happened. The form must not let one through.
  it("keeps Update Period disabled while the open editor is unchanged", async () => {
    const fetchMock = await openExistingPeriod();
    expect(updateButton().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("enables Update Period once a field actually changes, and again disables it when reverted", async () => {
    await openExistingPeriod();
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays (revised)" },
    });
    expect(updateButton().disabled).toBe(false);

    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "School Holidays" },
    });
    expect(updateButton().disabled).toBe(true);
  });

  it("still allows a first save on Create, where there is no persisted row to be unchanged from", async () => {
    await openForm();
    // Every field still holds the form's own defaults for hold days and rules;
    // only the required identity fields were filled. Create stays available.
    expect(createButton().disabled).toBe(false);
  });
});

describe("MinimumNightStaySection Save gating (#2142, #2143)", () => {
  const POLICY = {
    id: "m1",
    name: "Winter Saturdays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    triggerDays: [6],
    minimumNights: 2,
    active: true,
  };

  function stub(list: unknown[] = []) {
    const fetchMock = vi.fn(async () => jsonResponse(list));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function openForm() {
    stub([]);
    const { rerender } = render(<MinimumNightStaySection />);
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
    return () => rerender(<MinimumNightStaySection />);
  }

  async function openExistingPolicy() {
    const fetchMock = stub([POLICY]);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return fetchMock;
  }

  function createButton() {
    return screen.getByRole("button", {
      name: "Create Policy",
    }) as HTMLButtonElement;
  }

  function updateButton() {
    return screen.getByRole("button", {
      name: "Update Policy",
    }) as HTMLButtonElement;
  }

  it("enables Create Policy for an edit-capable admin", async () => {
    await openForm();
    expect(createButton().disabled).toBe(false);
  });

  it("disables Create Policy when the actor is narrowed mid-edit", async () => {
    const rerender = await openForm();
    narrowTo(false, rerender);
    expectViewOnly(createButton());
  });

  it("disables Create Policy neutrally while access is resolving", async () => {
    const rerender = await openForm();
    narrowTo(undefined, rerender);
    expectNeutralDisabled(createButton());
  });

  it("keeps Update Policy disabled while the open editor is unchanged", async () => {
    const fetchMock = await openExistingPolicy();
    expect(updateButton().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("enables Update Policy once a field actually changes", async () => {
    await openExistingPolicy();
    fireEvent.change(screen.getByLabelText("Minimum Nights"), {
      target: { value: "3" },
    });
    expect(updateButton().disabled).toBe(false);
  });

  // Trigger days are a SET: ticking a day and unticking it is not a change.
  it("treats a ticked-then-unticked trigger day as unchanged", async () => {
    await openExistingPolicy();
    const sunday = screen.getAllByRole("checkbox")[0];
    fireEvent.click(sunday);
    expect(updateButton().disabled).toBe(false);
    fireEvent.click(sunday);
    expect(updateButton().disabled).toBe(true);
  });
});

describe("DefaultCancellationPolicySection Save gating (#2142, #2143)", () => {
  const RULES = [
    {
      daysBeforeStay: 14,
      refundPercentage: 100,
      creditRefundPercentage: 100,
      fixedFeeCents: 0,
      creditFixedFeeCents: 0,
    },
  ];
  const LOADED = {
    rules: RULES,
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 7,
  };

  async function startEditing(body: unknown = LOADED) {
    const fetchMock = vi.fn(async () => jsonResponse(body));
    vi.stubGlobal("fetch", fetchMock);
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return fetchMock;
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

  it("enables Save Default Policy once a field changes", async () => {
    await startEditing();
    bumpHoldDays("9");
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

  // #2143: the cancellation PUT logs `cancellation-policy.update` and
  // revalidates the public pages unconditionally, so an Edit -> Save that
  // touched nothing used to record a policy change that never happened.
  it("keeps Save Default Policy disabled while the form is unchanged", async () => {
    const fetchMock = await startEditing();
    expect(saveButton().disabled).toBe(true);
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("re-disables Save Default Policy when a change is reverted by hand", async () => {
    await startEditing();
    bumpHoldDays("9");
    expect(saveButton().disabled).toBe(false);
    bumpHoldDays("7");
    expect(saveButton().disabled).toBe(true);
  });

  // #2142 first-save exception: the club-wide GET returns no rules on a club
  // that never saved a policy, and the form seeds itself from its own fallback
  // rules — so draft and snapshot are equal and gating on that alone would make
  // committing the defaults unreachable.
  it("allows a first save when no club-wide rules are persisted yet", async () => {
    await startEditing({
      rules: [],
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 7,
    });
    expect(saveButton().disabled).toBe(false);
  });

  it("does not extend that exception to a failed load", async () => {
    // A failed load leaves the same fallback rules in the form; treating that
    // as "nothing persisted" would let one click blind-write them over a real
    // configured policy.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(saveButton().disabled).toBe(true);
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
  // are not correctness fixes — they pin that the two Saves are shared themed
  // buttons participating in the section-level view-only treatment. Its own
  // dirty tracking (`timingDirty` / `attendeeTimingDirty`) is preserved
  // untouched.
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

  it("disables both Saves and explains it once, section-wide, when the actor is narrowed mid-edit", async () => {
    await loadSection();
    dirtyQuoteTiming("20");
    dirtyAttendeeTiming("21");
    expect(quoteButton().disabled).toBe(false);

    narrowTo(false, () => dirtyQuoteTiming("21"));

    expectViewOnly(quoteButton());
    expectViewOnly(attendeeButton());
    // One banner for the whole section, not one reason per button.
    expect(screen.getAllByRole("status")).toHaveLength(1);
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
