// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function payload() {
  return {
    preview: {
      seasonYear: 2026,
      decisionDate: "2026-07-13",
      dueDays: 30,
      totalCents: 12_000,
      confirmationToken: "a".repeat(64),
      entries: [{
        key: "entry-1",
        membershipTypeName: "Full",
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
    settings: { invoiceDueDays: 30 },
  };
}

function successResponse(body = payload()) {
  return Promise.resolve({ ok: true, json: async () => body });
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
});
