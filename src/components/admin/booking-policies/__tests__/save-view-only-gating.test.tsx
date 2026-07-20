// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactElement } from "react";
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

import { ClubIdentityProvider } from "@/components/club-identity-provider";
import { clubIdentity } from "@/config/club-identity";
import { BookingPeriodsSection } from "../booking-periods-section";
import { DefaultCancellationPolicySection } from "../default-cancellation-policy-section";
import { GroupDiscountSection } from "../group-discount-section";
import { MinimumNightStaySection } from "../minimum-night-stay-section";
import { PublicBookingRequestsSection } from "../public-booking-requests-section";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  ADMIN_VIEW_ONLY_SECTION_HEADING,
} from "@/components/admin/view-only-action";

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

/**
 * The section's view-only banner, as a live region.
 *
 * Queried by testid rather than by role (#2142 review): `PolicyFeedback` now
 * mounts its own permanently-registered regions — `role="alert"` for a save
 * failure, `role="status"` for a save confirmation — so "the status region" is
 * no longer unambiguous, and counting `role="status"` nodes across the whole
 * section would pin an unrelated component's a11y shape. The role is still
 * asserted here, once, because it is the property that matters.
 */
function viewOnlyBanner() {
  const banner = screen.getByTestId("admin-view-only-banner");
  expect(banner.getAttribute("role")).toBe("status");
  return banner;
}

function expectViewOnly(button: HTMLButtonElement) {
  expect(button.disabled).toBe(true);
  // The reason is NOT hung off the button any more (#2142 owner decision) …
  expect(button.getAttribute("title")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBeNull();
  // … it is announced once, in the reading order, by the section banner.
  expect(viewOnlyBanner().textContent).toContain(
    ADMIN_VIEW_ONLY_SECTION_HEADING,
  );
}

function expectNeutralDisabled(button: HTMLButtonElement) {
  // The resolving (`undefined`) window must not flash the read-only reason at
  // an admin who may well turn out to be edit-capable.
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("title")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBeNull();
  // The live region itself is always mounted (#2142 review) — a polite region
  // must be registered before its content changes or some screen-reader/browser
  // pairings drop the announcement. What must be absent is its CONTENT.
  expect(viewOnlyBanner().textContent).toBe("");
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

  // #2142 review (destructive): a failed FIRST load used to render the full
  // "Default Policy" editor over the hard-coded FALLBACK_RULES, indistinguishable
  // from real data. `CANCELLATION_DEFAULTS.scope` was `null` and club-wide scope
  // is ALSO `null`, so the round-2 scope invariant read `null === null` and
  // called the never-loaded seed authoritative for the scope the section mounts
  // on. `configured: true` blocked a PRISTINE save, but nothing blocked the
  // realistic one: click Edit, change the hold days, Save — and the PUT carries
  // `rules: FALLBACK_RULES`, which the route applies as `deleteMany` +
  // `createMany` over the whole club-wide partition. The club's real refund
  // schedule is gone.
  it("shows no editor at all when the FIRST load fails, so hardcoded fallbacks can never be saved over a real policy", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DefaultCancellationPolicySection />);

    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the policy for the club/i),
      ).toBeTruthy(),
    );
    // No way in: no Edit, therefore no Save, therefore no PUT.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save Default Policy" }),
    ).toBeNull();
    // And the fallback rules are not on screen dressed as the stored policy.
    expect(screen.queryByText("Default Policy")).toBeNull();
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  // The same seed, once a load SUCCEEDS, must still behave: a club with rules
  // stored is not "nothing persisted".
  it("re-opens the editor, dirty-gated, once a load finally succeeds", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail ? new Response("{}", { status: 500 }) : jsonResponse(LOADED),
      ),
    );
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByText(/Could not load the policy/i)).toBeTruthy(),
    );

    // A reload is the admin's remedy; simulate it by remounting.
    fail = false;
    cleanup();
    render(<DefaultCancellationPolicySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(saveButton().disabled).toBe(true);
  });
});

// #2142 review (a11y blocker): the polite live region has to be registered in
// the accessibility tree BEFORE its content changes. Every one of these sections
// short-circuits to a loading placeholder first, so if the banner lived only in
// the loaded branch, React would create the region AND its content in a single
// mutation — announced by some screen-reader/browser pairings and silently
// dropped by others. The region must therefore be mounted ABOVE each section's
// loading early-return.
describe("view-only live region is mounted before the loading early-return (#2142)", () => {
  function stubPendingFetch() {
    // Never resolves: the section stays in its loading branch for the assertion.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
  }

  /** Section, and a loaded body its own fetch can parse. */
  const SECTIONS: [string, () => ReactElement, unknown][] = [
    ["BookingPeriodsSection", () => <BookingPeriodsSection />, []],
    ["MinimumNightStaySection", () => <MinimumNightStaySection />, []],
    [
      "DefaultCancellationPolicySection",
      () => <DefaultCancellationPolicySection />,
      { rules: [], nonMemberHoldEnabled: true, nonMemberHoldDays: 7 },
    ],
    [
      "PublicBookingRequestsSection",
      () => <PublicBookingRequestsSection />,
      {
        showPricingToNonMembers: false,
        quoteResponseTtlDays: 14,
        quoteReminderLeadDays: 3,
        attendeeConfirmationLeadDays: 14,
        attendeeConfirmationReminderDays: 3,
      },
    ],
    [
      "GroupDiscountSection",
      () => (
        <ClubIdentityProvider value={clubIdentity}>
          <GroupDiscountSection />
        </ClubIdentityProvider>
      ),
      { minGroupSize: 5, summerOnly: true, enabled: false, configured: true },
    ],
  ];

  it.each(SECTIONS)(
    "%s mounts the region, empty, while still loading",
    (_name, renderSection) => {
      stubPendingFetch();
      // The real arrival order: the session has not resolved yet either.
      hookMock.canEdit = undefined;

      render(renderSection());

      // Still loading …
      expect(screen.getByText("Loading...")).toBeTruthy();
      // … and the region already exists and is empty, so the banner text that
      // lands later is a CONTENT change inside a registered region.
      expect(viewOnlyBanner().textContent).toBe("");
    },
  );

  it.each(SECTIONS)(
    "%s keeps the same region node from loading through to the resolved banner",
    async (_name, renderSection, body) => {
      let release: (value: Response) => void = () => {};
      const pending = new Promise<Response>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(() => pending),
      );
      hookMock.canEdit = undefined;

      const { rerender } = render(renderSection());
      const region = viewOnlyBanner();
      expect(region.textContent).toBe("");

      // The section's own fetch settles first …
      release(jsonResponse(body));
      await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
      expect(viewOnlyBanner()).toBe(region);
      expect(viewOnlyBanner().textContent).toBe("");

      // … then the session resolves the actor as view-only.
      narrowTo(false, () => rerender(renderSection()));

      // Same NODE, newly populated — an announcement, not an injection.
      expect(viewOnlyBanner()).toBe(region);
      expect(region.textContent).toContain(ADMIN_VIEW_ONLY_SECTION_HEADING);
    },
  );
});

// #2142 review: `PeriodForm` / `MinStayForm` mirror the hook's error up through
// `useEffect(() => onError(error))`, and the 403 path was rewritten to throw
// `ForbiddenSaveError` -> hook -> effect -> the parent's `PolicyFeedback`.
// Neither leg of that plumbing was covered.
describe("open-editor save failures reach the section feedback (#2142)", () => {
  function stubSaveOutcome(status: number, body: unknown = {}) {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (...args) =>
      args[1]?.method
        ? new Response(JSON.stringify(body), { status })
        : jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function createPeriod() {
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
    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));
  }

  async function createMinStay() {
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
    fireEvent.click(screen.getByRole("button", { name: "Create Policy" }));
  }

  it("surfaces a failed period save above the list, with the form still open", async () => {
    stubSaveOutcome(500, { error: "Overlapping period" });
    await createPeriod();

    await waitFor(() =>
      expect(screen.getByText("Overlapping period")).toBeTruthy(),
    );
    // The write failed, so the editor must stay open with the admin's draft.
    expect(screen.getByRole("button", { name: "Create Period" })).toBeTruthy();
    expect(
      (screen.getByLabelText("Period Name") as HTMLInputElement).value,
    ).toBe("School Holidays");
  });

  it("maps a 403 on a period save to the shared not-saved copy", async () => {
    // Defence in depth behind the UI gating (#1927): a stale tab whose actor was
    // narrowed after the page loaded.
    stubSaveOutcome(403);
    await createPeriod();

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
  });

  it("surfaces a failed minimum-stay save above the list", async () => {
    stubSaveOutcome(500, { error: "Overlapping policy" });
    await createMinStay();

    await waitFor(() =>
      expect(screen.getByText("Overlapping policy")).toBeTruthy(),
    );
    expect(screen.getByRole("button", { name: "Create Policy" })).toBeTruthy();
  });

  it("maps a 403 on a minimum-stay save to the shared not-saved copy", async () => {
    stubSaveOutcome(403);
    await createMinStay();

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
  });

  // #2142 review: the save callback now parses the server row AFTER the write
  // has already succeeded. On an EDIT that is safe — the retry re-PUTs the same
  // row — but on a CREATE the row exists while the form still has no id, so
  // leaving the form open turns the natural retry into a SECOND row.
  describe("a 2xx whose body cannot be parsed", () => {
    function stubUnparseableWrite() {
      const fetchMock = vi.fn<
        (url: string, init?: RequestInit) => Promise<Response>
      >(async (...args) =>
        args[1]?.method
          ? // A truncated proxy response: 2xx, but not the row.
            new Response("<html>502 upstream</html>", { status: 200 })
          : jsonResponse([PERIOD_ROW]),
      );
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    const PERIOD_ROW = {
      id: "p1",
      name: "School Holidays",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-14T00:00:00.000Z",
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 5,
      cancellationRules: [],
      active: true,
    };

    it("closes the CREATE form anyway, so a retry cannot POST a second period", async () => {
      const fetchMock = stubUnparseableWrite();
      await createPeriod();

      await waitFor(() =>
        expect(screen.getByText("Period created")).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: "Create Period" })).toBeNull();
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    });

    it("closes the CREATE form anyway, so a retry cannot POST a second minimum-stay policy", async () => {
      const fetchMock = vi.fn<
        (url: string, init?: RequestInit) => Promise<Response>
      >(async (...args) =>
        args[1]?.method
          ? new Response("<html>502 upstream</html>", { status: 200 })
          : jsonResponse([]),
      );
      vi.stubGlobal("fetch", fetchMock);
      await createMinStay();

      await waitFor(() =>
        expect(screen.getByText("Minimum stay policy created")).toBeTruthy(),
      );
      expect(screen.queryByRole("button", { name: "Create Policy" })).toBeNull();
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    });

    it("keeps the EDIT form open and says so, because re-PUTting the same row is idempotent", async () => {
      stubUnparseableWrite();
      render(<BookingPeriodsSection />);
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.change(screen.getByLabelText("Period Name"), {
        target: { value: "School Holidays (revised)" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Update Period" }));

      await waitFor(() =>
        expect(screen.getByText(/could not be read/i)).toBeTruthy(),
      );
      expect(screen.getByRole("button", { name: "Update Period" })).toBeTruthy();
    });
  });

  // #2142 review: Cancel closes the editor, so the message the editor mirrored
  // up must go with it — the child clears its own error on unmount but the
  // parent's copy is one-way, so it used to outlive the form that caused it.
  it("clears the mirrored error when the editor is cancelled", async () => {
    stubSaveOutcome(500, { error: "Overlapping period" });
    await createPeriod();
    await waitFor(() =>
      expect(screen.getByText("Overlapping period")).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Overlapping period")).toBeNull();
  });

  // #2142 review: re-clicking Edit on the row that is ALREADY open must reset
  // the form. The editor is keyed, and without an instance counter the key is
  // unchanged for the same row, so React reuses the hook instance and the fresh
  // `initial` is ignored — the unsaved draft silently survives.
  it("resets the editor when Edit is clicked again on the row already open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            id: "p1",
            name: "School Holidays",
            startDate: "2026-07-01T00:00:00.000Z",
            endDate: "2026-07-14T00:00:00.000Z",
            nonMemberHoldEnabled: true,
            nonMemberHoldDays: 5,
            cancellationRules: [],
            active: true,
          },
        ]),
      ),
    );
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Period Name"), {
      target: { value: "Abandoned edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      (screen.getByLabelText("Period Name") as HTMLInputElement).value,
    ).toBe("School Holidays");
    expect(
      (screen.getByRole("button", { name: "Update Period" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
    // One banner for the whole section, not one reason per button. Asserted on
    // the banner specifically rather than by counting every `role="status"` in
    // the section, which would also sweep up `PolicyFeedback`'s save-confirmation
    // region and break the moment an unrelated live region is added (#2142
    // review).
    expect(screen.getAllByTestId("admin-view-only-banner")).toHaveLength(1);
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

// #2142 review (#2143, second route in): Activate/Deactivate is a one-click
// direct write, never covered by the Save dirty gate. It read `active` off a row
// that only changes once the refresh resolves, so two quick clicks both saw the
// old value and both sent the same new one — the second PUT writing an update
// entry whose `before` and `after` are identical AND busting the public-page
// cache. One admin, no concurrency required.
describe("row toggles are guarded against a double-click (#2143)", () => {
  const PERIOD = {
    id: "p1",
    name: "School Holidays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-07-14T00:00:00.000Z",
    nonMemberHoldEnabled: true,
    nonMemberHoldDays: 5,
    cancellationRules: [],
    active: true,
  };

  const POLICY = {
    id: "m1",
    name: "Winter Saturdays",
    startDate: "2026-07-01T00:00:00.000Z",
    endDate: "2026-09-30T00:00:00.000Z",
    triggerDays: [6],
    minimumNights: 2,
    active: true,
  };

  /**
   * Two clicks with genuinely NO render between them.
   *
   * `fireEvent` twice does NOT test this guard (#2142 review, round 4): RTL
   * wraps each dispatch in its own `act()`, so the first click's
   * `setTogglingId` is flushed before the second is dispatched, the button is
   * already `disabled`, and React never calls the handler again. That passes
   * with or without `togglingRef` — it only re-tests the `disabled` attribute.
   *
   * The guard exists for the case `disabled` alone cannot catch: a real
   * double-click delivered inside one tick, where BOTH handlers run against the
   * same pre-update state. Dispatching both inside a SINGLE `act()` reproduces
   * exactly that — no commit in between, so the second dispatch reaches a button
   * that is still enabled and a handler that still sees `active: true`.
   */
  async function doubleClickInOneTick(button: HTMLElement) {
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  /** GETs return the list unchanged, so the row never flips on its own. */
  function stubList(list: unknown[]) {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (...args) =>
      args[1]?.method ? jsonResponse({}) : jsonResponse(list),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends one booking-period PUT for two clicks in the same tick", async () => {
    const fetchMock = stubList([PERIOD]);
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy(),
    );

    const toggle = screen.getByRole("button", { name: "Deactivate" });
    await doubleClickInOneTick(toggle);

    await waitFor(() => expect(writeCalls(fetchMock).length).toBeGreaterThan(0));
    expect(writeCalls(fetchMock)).toHaveLength(1);
    expect(
      JSON.parse(String(writeCalls(fetchMock)[0][1]?.body)),
    ).toEqual({ active: false });
  });

  it("sends one minimum-stay PUT for two clicks in the same tick", async () => {
    const fetchMock = stubList([POLICY]);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy(),
    );

    const toggle = screen.getByRole("button", { name: "Deactivate" });
    await doubleClickInOneTick(toggle);

    await waitFor(() => expect(writeCalls(fetchMock).length).toBeGreaterThan(0));
    expect(writeCalls(fetchMock)).toHaveLength(1);
  });

  // #2142 review: an active minimum-stay row used to carry TWO buttons both
  // labelled "Deactivate" — the reversible toggle and the (soft) delete — with
  // nothing but the colour to tell them apart.
  it("gives an active minimum-stay row one Deactivate and one Delete", async () => {
    stubList([POLICY]);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Deactivate" })).toBeTruthy(),
    );

    expect(screen.getAllByRole("button", { name: "Deactivate" })).toHaveLength(
      1,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
  });
});

// #2142 review (a11y): `PolicyFeedback` is where every booking-policy section
// reports the outcome of a write — including the 403 "not saved" copy this
// change added plumbing for — and it had no live region at all, so none of it
// was announced to anybody. The two halves are deliberately different: a
// FAILURE contradicts what the admin believes just happened and interrupts
// (`role="alert"`), a confirmation only reassures and waits its turn
// (`role="status"`).
describe("PolicyFeedback announces save outcomes (#2142)", () => {
  function stubSaveOutcome(status: number, body: unknown = {}) {
    const fetchMock = vi.fn<
      (url: string, init?: RequestInit) => Promise<Response>
    >(async (...args) =>
      args[1]?.method
        ? new Response(JSON.stringify(body), { status })
        : jsonResponse([]),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function fillNewPeriod() {
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

  it("announces a failed save assertively", async () => {
    stubSaveOutcome(500, { error: "Overlapping period" });
    render(<BookingPeriodsSection />);
    await fillNewPeriod();
    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));

    await waitFor(() =>
      expect(screen.getByText("Overlapping period")).toBeTruthy(),
    );
    expect(
      within(screen.getByRole("alert")).getByText(/Overlapping period/),
    ).toBeTruthy();
  });

  it("announces the shared 403 not-saved copy assertively", async () => {
    stubSaveOutcome(403);
    render(<BookingPeriodsSection />);
    await fillNewPeriod();
    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));

    await waitFor(() =>
      expect(screen.getByText(ADMIN_FORBIDDEN_SAVE_REASON)).toBeTruthy(),
    );
    expect(
      within(screen.getByRole("alert")).getByText(ADMIN_FORBIDDEN_SAVE_REASON),
    ).toBeTruthy();
  });

  it("announces a successful save politely, in a region that was already registered", async () => {
    stubSaveOutcome(200, {
      id: "p1",
      name: "School Holidays",
      startDate: "2026-07-01T00:00:00.000Z",
      endDate: "2026-07-14T00:00:00.000Z",
      nonMemberHoldEnabled: true,
      nonMemberHoldDays: 5,
      cancellationRules: [],
      active: true,
    });
    render(<BookingPeriodsSection />);
    await fillNewPeriod();

    // Both regions exist and are EMPTY before anything is saved. That ordering
    // is the whole point: a live region injected already-populated in a single
    // mutation is silently dropped by some screen-reader/browser pairings, so
    // the message has to land as a content change inside a registered region.
    const alertRegion = screen.getByRole("alert");
    const statusRegion = screen
      .getAllByRole("status")
      .filter((node) => node.dataset.testid !== "admin-view-only-banner");
    expect(statusRegion).toHaveLength(1);
    expect(alertRegion.textContent).toBe("");
    expect(statusRegion[0].textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Create Period" }));

    await waitFor(() => expect(screen.getByText("Period created")).toBeTruthy());
    // Same NODE, newly populated — and the confirmation is polite, not an alert.
    expect(statusRegion[0].textContent).toContain("Period created");
    expect(screen.getByRole("alert").textContent).toBe("");
  });
});
