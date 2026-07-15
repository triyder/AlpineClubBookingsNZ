// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn(), scrollToError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));
vi.mock("@/hooks/use-scroll-to-feedback", () => ({
  useScrollToFeedback: () => ({ scrollToError: mocks.scrollToError, scrollToTop: vi.fn() }),
}));

let FeeConfigurationPage: typeof import("@/app/(admin)/admin/fee-configuration/page").default;

const editableData = {
  canEdit: true,
  familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER",
  membershipTypes: [{
    id: "type-1", name: "Full", isActive: true,
    annualFees: [{ id: "fee-1", amountCents: 10000, effectiveFrom: "2026-01-01", effectiveTo: null, billingBasis: "PER_MEMBER", prorationRule: "NONE" }],
  }],
  entranceFees: [{ id: "entrance-1", category: "ADULT", amountCents: 5000, effectiveFrom: "2026-01-01", effectiveTo: null }],
  currentEntranceFees: [{ category: "ADULT", amountCents: 5000, source: "SCHEDULE" }],
  familyGroups: [{
    id: "family-1", name: "Example family", billingMemberId: "member-1", billingException: false,
    members: [{ id: "member-1", firstName: "Alex", lastName: "Example", email: "alex@example.test", active: true }],
  }],
};

// Three membered families exercise the multi-family Save loop. Each family has
// two active members so a billing member can be switched to the second one.
const multiFamilyData = {
  canEdit: true,
  familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER",
  membershipTypes: editableData.membershipTypes,
  entranceFees: editableData.entranceFees,
  currentEntranceFees: editableData.currentEntranceFees,
  familyGroups: [
    {
      id: "family-1", name: "Alpha family", billingMemberId: "m1a", billingException: false,
      members: [
        { id: "m1a", firstName: "Amy", lastName: "Alpha", email: "amy@alpha.test", active: true },
        { id: "m1b", firstName: "Aaron", lastName: "Alpha", email: "aaron@alpha.test", active: true },
      ],
    },
    {
      id: "family-2", name: "Beta family", billingMemberId: "m2a", billingException: false,
      members: [
        { id: "m2a", firstName: "Ben", lastName: "Beta", email: "ben@beta.test", active: true },
        { id: "m2b", firstName: "Bella", lastName: "Beta", email: "bella@beta.test", active: true },
      ],
    },
    {
      id: "family-3", name: "Gamma family", billingMemberId: "m3a", billingException: false,
      members: [
        { id: "m3a", firstName: "Gina", lastName: "Gamma", email: "gina@gamma.test", active: true },
        { id: "m3b", firstName: "Greg", lastName: "Gamma", email: "greg@gamma.test", active: true },
      ],
    },
  ],
};

function response(ok: boolean, body: unknown) {
  return { ok, json: async () => body } as Response;
}

// Stage a billing member on the Nth family Select (0-based, DOM order matches
// the fixture). Same keyboard-driven Radix open as selectRadixOption, but
// targets one of several identically-named "Billing member" comboboxes.
function stageFamilyBilling(index: number, optionName: RegExp | string) {
  const triggers = screen.getAllByRole("combobox", { name: "Billing member" });
  fireEvent.keyDown(triggers[index], { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

// Post bodies for SET_FAMILY_BILLING_MEMBER, in call order.
function familyBillingPosts(fetchMock: ReturnType<typeof vi.fn>) {
  return postCalls(fetchMock)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    .filter((body) => body.action === "SET_FAMILY_BILLING_MEMBER");
}

// The only POST is the mutation call; the initial load is a bodyless GET.
function postCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
}
function postBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = postCalls(fetchMock).at(-1);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : null;
}

// Radix Select needs these DOM APIs jsdom does not implement to open its listbox.
// Keyboard opening (ArrowDown on the trigger) is the reliable path in jsdom.
function selectRadixOption(triggerName: string, optionName: RegExp | string) {
  const trigger = screen.getByRole("combobox", { name: triggerName });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

beforeAll(async () => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-13T12:30:00.000Z")); // 14 July in Pacific/Auckland
  FeeConfigurationPage = (await import("@/app/(admin)/admin/fee-configuration/page")).default;
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("fee configuration page", () => {
  it("renders finance viewers read-only with no edit affordances", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(true, { ...editableData, canEdit: false })));
    render(<FeeConfigurationPage />);
    expect(await screen.findByText(/finance view access is read-only/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit membership fees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit entrance fees" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit family billing" })).toBeNull();
    // No forms, no per-row controls, no billing Select while read-only.
    expect(screen.queryByLabelText("Annual amount (NZD)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Full fee" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Billing member" })).toBeNull();
    // Saved values still render (fee schedule + billing member as static text).
    expect(screen.getByText("$100.00")).toBeTruthy();
    expect(screen.getByText(/Alex Example/)).toBeTruthy();
  });

  it("gates the membership form and row controls behind Edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(true, editableData)));
    render(<FeeConfigurationPage />);
    await screen.findByRole("button", { name: "Edit membership fees" });
    // Read-only on load: schedule shown, but no form and no pencil.
    expect(screen.getByText("$100.00")).toBeTruthy();
    expect(screen.queryByLabelText("Annual amount (NZD)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit Full fee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit membership fees" }));
    expect(screen.getByLabelText("Annual amount (NZD)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Full fee" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add annual fee" })).toBeTruthy();
  });

  it("uses the NZ date and discards membership form edits on cancel with no API call", async () => {
    const fetchMock = vi.fn(async () => response(true, editableData));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    expect((document.querySelector("#membership-from") as HTMLInputElement).value).toBe("2026-07-14");
    fireEvent.click(screen.getByRole("button", { name: "Edit Full fee" }));
    expect((screen.getByLabelText("Annual amount (NZD)") as HTMLInputElement).value).toBe("100.00");
    fireEvent.click(screen.getByRole("button", { name: "Close section" }));
    // Close section leaves edit mode; re-entering shows a fresh add form.
    expect(screen.queryByLabelText("Annual amount (NZD)")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit membership fees" }));
    expect((screen.getByLabelText("Annual amount (NZD)") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("#membership-from") as HTMLInputElement).value).toBe("2026-07-14");
    expect(postCalls(fetchMock)).toHaveLength(0);
  });

  it("commits an unchanged membership fee payload from edit mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, editableData))
      .mockResolvedValueOnce(response(true, editableData));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Full fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Update annual fee" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Fee schedule saved"));
    // Stays in edit mode after commit, back in add-mode.
    expect(screen.getByRole("button", { name: "Add annual fee" })).toBeTruthy();
    expect(postBody(fetchMock)).toEqual({
      action: "UPDATE_MEMBERSHIP_FEE", id: "fee-1", amountCents: 10000,
      billingBasis: "PER_MEMBER", prorationRule: "NONE", effectiveFrom: "2026-01-01", effectiveTo: null,
    });
  });

  it("retains membership edit mode and surfaces feedback when an update fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, editableData))
      .mockResolvedValueOnce(response(false, { error: "Overlapping schedule" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Full fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Update annual fee" }));
    expect(await screen.findByText("Overlapping schedule")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update annual fee" })).toBeTruthy();
    expect(mocks.toastError).toHaveBeenCalledWith("Overlapping schedule");
    await waitFor(() => expect(mocks.scrollToError).toHaveBeenCalled());
  });

  it("keeps failed delete confirmation context inside membership edit mode", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, editableData))
      .mockResolvedValueOnce(response(false, { error: "Delete failed" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit membership fees" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Full fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete fee" }));
    expect(await screen.findByText("Delete failed")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Full annual fee from 2026-01-01/)).toBeTruthy();
  });

  it("gates the entrance fee form and row controls behind Edit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(true, editableData)));
    render(<FeeConfigurationPage />);
    await screen.findByRole("button", { name: "Edit entrance fees" });
    expect(screen.queryByLabelText("Amount (NZD)")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit ADULT fee" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit entrance fees" }));
    expect(screen.getByLabelText("Amount (NZD)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit ADULT fee" })).toBeTruthy();
  });

  it("does not call SET_FAMILY_BILLING_MEMBER until the family section Save", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, editableData))
      .mockResolvedValueOnce(response(true, editableData));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    await screen.findByRole("button", { name: "Edit family billing" });
    // Read-only: billing member is static text, no Select yet.
    expect(screen.queryByRole("combobox", { name: "Billing member" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit family billing" }));
    // Staging a change must not fire the API.
    selectRadixOption("Billing member", /No billing member/);
    expect(postCalls(fetchMock)).toHaveLength(0);
    // Save commits the staged selection with the unchanged payload shape.
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Billing members updated"));
    expect(postBody(fetchMock)).toEqual({
      action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: null,
    });
  });

  it("reverts staged family billing changes on Cancel with no API call", async () => {
    const fetchMock = vi.fn(async () => response(true, editableData));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit family billing" }));
    selectRadixOption("Billing member", /No billing member/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back to read-only showing the original saved member; nothing persisted.
    expect(screen.getByText(/Alex Example/)).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Billing member" })).toBeNull();
    expect(postCalls(fetchMock)).toHaveLength(0);
  });

  it("posts only changed families on Save, one SET_FAMILY_BILLING_MEMBER call each", async () => {
    const fetchMock = vi.fn(async () => response(true, multiFamilyData));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit family billing" }));
    // Change families 1 and 3; leave family 2 (index 1) on its saved member.
    stageFamilyBilling(0, /Aaron Alpha/);
    stageFamilyBilling(2, /Greg Gamma/);
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Billing members updated"));
    // Exactly one call per changed family, correct body, unchanged family never sent.
    const posts = familyBillingPosts(fetchMock);
    expect(posts).toEqual([
      { action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-1", billingMemberId: "m1b" },
      { action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: "family-3", billingMemberId: "m3b" },
    ]);
    expect(posts.filter((body) => body.familyGroupId === "family-2")).toHaveLength(0);
    // One summary toast, not one per changed family.
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
  });

  it("stops the family Save loop on first failure and resumes without re-sending saved families", async () => {
    // Stateful server: successful saves update billing member so a retry no
    // longer treats that family as changed. Family 2 fails on its first attempt.
    const families = JSON.parse(JSON.stringify(multiFamilyData.familyGroups)) as typeof multiFamilyData.familyGroups;
    let family2Attempts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return response(true, { ...multiFamilyData, familyGroups: families });
      const body = JSON.parse(String(init.body));
      if (body.familyGroupId === "family-2") {
        family2Attempts += 1;
        if (family2Attempts === 1) return response(false, { error: "Billing member must be active" });
      }
      const target = families.find((group) => group.id === body.familyGroupId);
      if (target) target.billingMemberId = body.billingMemberId;
      return response(true, { ...multiFamilyData, familyGroups: families });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit family billing" }));
    // Stage a change on all three families.
    stageFamilyBilling(0, /Aaron Alpha/);
    stageFamilyBilling(1, /Bella Beta/);
    stageFamilyBilling(2, /Greg Gamma/);
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    // Loop stops on family 2's failure: family 1 saved, family 3 never attempted.
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith("Billing member must be active"));
    const firstRun = familyBillingPosts(fetchMock);
    expect(firstRun.map((body) => body.familyGroupId)).toEqual(["family-1", "family-2"]);
    // No success summary while the loop failed part way.
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    // Edit mode stays open and staged edits survive.
    expect(screen.getByRole("button", { name: "Save billing members" })).toBeTruthy();
    expect(screen.getAllByRole("combobox", { name: "Billing member" })).toHaveLength(3);

    // Retry: already-saved family 1 is not re-sent; family 2 (now succeeding) and 3 are.
    fireEvent.click(screen.getByRole("button", { name: "Save billing members" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Billing members updated"));
    const allPosts = familyBillingPosts(fetchMock);
    expect(allPosts.filter((body) => body.familyGroupId === "family-1")).toHaveLength(1);
    expect(allPosts.filter((body) => body.familyGroupId === "family-2")).toHaveLength(2);
    expect(allPosts.filter((body) => body.familyGroupId === "family-3")).toHaveLength(1);
    // Retry only re-sent the still-unsaved families, in order.
    expect(allPosts.slice(2).map((body) => body.familyGroupId)).toEqual(["family-2", "family-3"]);
  });

  it("hides the family billing card and per-family basis when the club bills members individually", async () => {
    const individualData = { ...editableData, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY" };
    vi.stubGlobal("fetch", vi.fn(async () => response(true, individualData)));
    render(<FeeConfigurationPage />);
    // Membership section still loads; family card is gone entirely.
    await screen.findByRole("button", { name: "Edit membership fees" });
    expect(screen.queryByRole("button", { name: "Edit family billing" })).toBeNull();
    expect(screen.queryByText("Family billing members")).toBeNull();
    expect(screen.queryByText("Billing exception")).toBeNull();
    // Per-family is not offered in the membership billing basis Select.
    fireEvent.click(screen.getByRole("button", { name: "Edit membership fees" }));
    selectRadixOption("Billing basis", /Per member/);
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Billing basis" }), { key: "ArrowDown" });
    expect(screen.queryByRole("option", { name: "Per family" })).toBeNull();
    expect(screen.getByRole("option", { name: "No invoice" })).toBeTruthy();
  });

  it("warns about stale per-family schedules under individual billing", async () => {
    const staleData = {
      ...editableData,
      familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
      membershipTypes: [{
        id: "type-1", name: "Full", isActive: true,
        annualFees: [{ id: "fee-1", amountCents: 10000, effectiveFrom: "2026-01-01", effectiveTo: null, billingBasis: "PER_FAMILY", prorationRule: "NONE" }],
      }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => response(true, staleData)));
    render(<FeeConfigurationPage />);
    expect(await screen.findByText(/one or more schedules still use the per-family basis/i)).toBeTruthy();
  });
});
