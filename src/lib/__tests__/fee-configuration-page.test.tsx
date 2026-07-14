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

function response(ok: boolean, body: unknown) {
  return { ok, json: async () => body } as Response;
}

beforeAll(async () => {
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
  it("renders finance viewers deliberately read-only with labelled controls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(true, { ...editableData, canEdit: false })));
    render(<FeeConfigurationPage />);
    expect(await screen.findByText(/finance view access is read-only/i)).toBeTruthy();
    expect((screen.getByLabelText("Annual amount (NZD)") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Billing member") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Edit Full fee" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("uses the New Zealand date and fully resets an edited membership form on cancel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(true, editableData)));
    render(<FeeConfigurationPage />);
    expect(await screen.findByRole("button", { name: "Edit Full fee" })).toBeTruthy();
    expect((document.querySelector("#membership-from") as HTMLInputElement).value).toBe("2026-07-14");
    fireEvent.click(screen.getByRole("button", { name: "Edit Full fee" }));
    expect((screen.getByLabelText("Annual amount (NZD)") as HTMLInputElement).value).toBe("100.00");
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect((screen.getByLabelText("Annual amount (NZD)") as HTMLInputElement).value).toBe("");
    expect((document.querySelector("#membership-from") as HTMLInputElement).value).toBe("2026-07-14");
  });

  it("retains edit mode and scrolls to persistent feedback when an update fails", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, editableData))
      .mockResolvedValueOnce(response(false, { error: "Overlapping schedule" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Full fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Update annual fee" }));
    expect(await screen.findByText("Overlapping schedule")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update annual fee" })).toBeTruthy();
    expect(mocks.toastError).toHaveBeenCalledWith("Overlapping schedule");
    await waitFor(() => expect(mocks.scrollToError).toHaveBeenCalled());
  });

  it("confirms a successful financial configuration save", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, editableData))
      .mockResolvedValueOnce(response(true, editableData));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Full fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Update annual fee" }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith("Fee schedule saved"));
    expect(screen.getByRole("button", { name: "Add annual fee" })).toBeTruthy();
  });

  it("keeps failed delete confirmation context", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(true, editableData))
      .mockResolvedValueOnce(response(false, { error: "Delete failed" }));
    vi.stubGlobal("fetch", fetchMock);
    render(<FeeConfigurationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Full fee" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete fee" }));
    expect(await screen.findByText("Delete failed")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Full annual fee from 2026-01-01/)).toBeTruthy();
  });
});
