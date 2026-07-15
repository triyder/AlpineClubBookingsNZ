// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canEdit: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: mocks.canEdit,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View only",
}));
vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: mocks.confirm, confirmDialog: null }),
}));
vi.mock("@/lib/date-only", () => ({
  todayDateOnlyForTimeZone: () => "2026-07-13",
}));

import { SubscriptionBillingPanel } from "@/app/(admin)/admin/subscriptions/_components/subscription-billing-panel";

function payload(options: { decisionDate?: string; membershipTypeName?: string } = {}) {
  const decisionDate = options.decisionDate ?? "2026-07-13";
  const membershipTypeName = options.membershipTypeName ?? "Full";
  return {
    preview: {
      seasonYear: 2026,
      decisionDate,
      dueDays: 30,
      totalCents: 12_000,
      confirmationToken: "a".repeat(64),
      entries: [{
        key: "entry-1",
        membershipTypeName,
        billingBasis: "PER_MEMBER",
        prorationRule: "NONE",
        chargedAmountCents: 12_000,
        coveredMonths: 12,
        xeroAccountCode: "203",
        xeroItemCode: "SUB",
        recipient: { name: "Member One" },
        coveredMembers: [{ id: "member-1", name: "Member One" }],
      }],
      exceptions: [{ fingerprint: "same", message: "Configure billing" }],
    },
    charges: [{
      id: "charge-1",
      status: "EMAIL_FAILED",
      membershipTypeName: "Full",
      chargedAmountCents: 12_000,
      recipientName: "Member One",
      xeroInvoiceNumber: "INV-1",
      lastErrorMessage: "Mail failed",
      coverage: [{ memberName: "Member One" }],
    }],
    exceptions: [{ id: "exception-1", fingerprint: "same", message: "Configure billing" }],
    settings: { invoiceDueDays: 30, familyBillingMode: "BILL_FAMILY_VIA_BILLING_MEMBER" },
  };
}

function successResponse(body = payload()) {
  return Promise.resolve({ ok: true, json: async () => body } as Response);
}

describe("subscription billing panel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue(false);
    vi.stubGlobal("fetch", vi.fn(() => successResponse()));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps finance mutations disabled for view-only admins and deduplicates exceptions", async () => {
    mocks.canEdit.mockReturnValue(false);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText(/Finance view access can inspect/)).toBeTruthy();
    expect(screen.getByLabelText("Invoice due days").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Save due days" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Confirm and queue annual batch" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Retry" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByText("Configure billing")).toHaveLength(1);
    expect(screen.getByText("Open exceptions").nextSibling?.textContent).toBe("1");
  });

  it("removes an actionable preview immediately when its date changes and keeps it cleared after refresh failure", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect((await screen.findByRole("button", { name: "Confirm and queue annual batch" })).hasAttribute("disabled")).toBe(false);
    fetchMock.mockRejectedValueOnce(new Error("preview unavailable"));
    fireEvent.change(screen.getByLabelText("Decision date"), { target: { value: "2026-08-01" } });
    expect(screen.queryByRole("button", { name: "Confirm and queue annual batch" })).toBeNull();
    expect(await screen.findByText("preview unavailable")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm and queue annual batch" })).toBeNull());
  });

  it("ignores an older preview response after the newer date request fails", async () => {
    mocks.canEdit.mockReturnValue(true);
    let resolveOlder: ((value: Response) => void) | undefined;
    const older = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementationOnce(() => older);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    fetchMock.mockRejectedValueOnce(new Error("newer preview failed"));
    fireEvent.change(screen.getByLabelText("Decision date"), { target: { value: "2026-08-01" } });
    expect(await screen.findByText("newer preview failed")).toBeTruthy();

    await act(async () => {
      resolveOlder?.({ ok: true, json: async () => payload() } as Response);
      await older;
    });
    expect(screen.getByText("newer preview failed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm and queue annual batch" })).toBeNull();
  });

  it("clears a load error after refresh succeeds and preserves mutation success through its reload", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockRejectedValueOnce(new Error("temporary preview failure"));
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText("temporary preview failure")).toBeTruthy();
    fetchMock.mockImplementationOnce(() => successResponse());
    fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
    expect(await screen.findByRole("button", { name: "Confirm and queue annual batch" })).toBeTruthy();
    expect(screen.queryByText("temporary preview failure")).toBeNull();

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: "Due days saved" }) } as never)
      .mockImplementationOnce(() => successResponse());
    fireEvent.click(screen.getByRole("button", { name: "Save due days" }));
    expect(await screen.findByText("Due days saved")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm and queue annual batch" })).toBeTruthy());
    expect(screen.getByText("Due days saved")).toBeTruthy();
  });

  it("saves the selected family billing mode with the current due days", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    await screen.findByRole("button", { name: "Save billing mode" });
    // Switch the mode via the Select, then save.
    const trigger = screen.getByRole("combobox", { name: "Family billing mode" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Bill members individually" }));
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => ({ message: "Subscription billing settings updated." }) } as Response));
    fireEvent.click(screen.getByRole("button", { name: "Save billing mode" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
    });
  });

  it("saves the billing mode with the last-saved due days, ignoring an unsaved due-days edit", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    render(<SubscriptionBillingPanel seasonYear={2026} />);
    await screen.findByRole("button", { name: "Save billing mode" });
    // Type a new due-days value but do NOT save it, then save the mode.
    fireEvent.change(screen.getByLabelText("Invoice due days"), { target: { value: "45" } });
    const trigger = screen.getByRole("combobox", { name: "Family billing mode" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Bill members individually" }));
    fetchMock.mockClear();
    fetchMock.mockImplementationOnce(() => Promise.resolve({ ok: true, json: async () => ({ message: "Subscription billing settings updated." }) } as Response));
    fireEvent.click(screen.getByRole("button", { name: "Save billing mode" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(true));
    const postCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    // The unsaved "45" is not persisted; the last-saved 30 is sent instead.
    expect(JSON.parse(String((postCall![1] as RequestInit).body))).toEqual({
      action: "UPDATE_SETTINGS", invoiceDueDays: 30, familyBillingMode: "BILL_MEMBERS_INDIVIDUALLY",
    });
  });

  it("reloads the latest selection when an older-selection mutation completes", async () => {
    mocks.canEdit.mockReturnValue(true);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockReset();
    let resolvePost: ((value: Response) => void) | undefined;
    const pendingPost = new Promise<Response>((resolve) => {
      resolvePost = resolve;
    });
    const getUrls: string[] = [];
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return pendingPost;
      const url = String(input);
      getUrls.push(url);
      if (url.includes("decisionDate=2026-08-01")) {
        return { ok: true, json: async () => payload({ decisionDate: "2026-08-01", membershipTypeName: "August Full" }) } as Response;
      }
      return { ok: true, json: async () => payload() } as Response;
    });

    render(<SubscriptionBillingPanel seasonYear={2026} />);
    expect(await screen.findByText(/^Full · Member One$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save due days" }));
    fireEvent.change(screen.getByLabelText("Decision date"), { target: { value: "2026-08-01" } });
    expect(await screen.findByText(/^August Full · Member One$/)).toBeTruthy();

    await act(async () => {
      resolvePost?.({ ok: true, json: async () => ({ message: "Due days saved" }) } as Response);
      await pendingPost;
    });
    expect(await screen.findByText("Due days saved")).toBeTruthy();
    expect(await screen.findByText(/^August Full · Member One$/)).toBeTruthy();
    expect(screen.queryByText(/^Full · Member One$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm and queue annual batch" }).hasAttribute("disabled")).toBe(false);
    expect(getUrls.at(-1)).toContain("decisionDate=2026-08-01");
  });
});
