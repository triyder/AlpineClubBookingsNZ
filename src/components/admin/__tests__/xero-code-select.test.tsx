// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XeroAccountSelect, XeroItemSelect } from "@/components/admin/xero-code-select";

const accounts = [
  { code: "203", name: "Subscriptions Income", type: "REVENUE", class: "REVENUE" },
  { code: "260", name: "Other Revenue", type: "REVENUE", class: "REVENUE" },
  { code: "090", name: "Bank", type: "BANK", class: "ASSET" },
];
const items = [
  { itemID: "i1", code: "MEMBER", name: "Membership", description: "" },
];

afterEach(() => vi.clearAllMocks());

describe("XeroAccountSelect", () => {
  it("shows the empty-state default label and offers only REVENUE-class accounts", () => {
    const onChange = vi.fn();
    render(
      <XeroAccountSelect
        accounts={accounts}
        value=""
        onChange={onChange}
        emptyLabel="Default: 203 — Subscriptions Income"
        ariaLabel="Account"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Account" });
    expect(trigger.textContent).toContain("Default: 203 — Subscriptions Income");
    fireEvent.click(trigger);
    expect(screen.getByRole("button", { name: /260.*Other Revenue/ })).toBeTruthy();
    // The ASSET/BANK account is filtered out of a REVENUE picker.
    expect(screen.queryByRole("button", { name: /090.*Bank/ })).toBeNull();
  });

  it("emits the chosen code (upper-cased) and can reset to the default", () => {
    const onChange = vi.fn();
    render(
      <XeroAccountSelect
        accounts={accounts}
        value="260"
        onChange={onChange}
        emptyLabel="Default: 203 — Subscriptions Income"
        ariaLabel="Account"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Account" });
    // A selected value renders as "CODE — Name".
    expect(trigger.textContent).toContain("260 — Other Revenue");
    fireEvent.click(trigger);
    // Anchor to the option (not the "Default: 203 …" reset row, which also contains 203).
    fireEvent.click(screen.getByRole("button", { name: /^203/ }));
    expect(onChange).toHaveBeenCalledWith("203");
    // Reopening and choosing the default row clears the stored code.
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /Default: 203/ }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("hides the manual-code affordance without allowManualCodes", () => {
    const { unmount } = render(
      <XeroAccountSelect accounts={[]} value="" onChange={vi.fn()} emptyLabel="Default" ariaLabel="Account" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.change(screen.getByPlaceholderText(/Search account code/), { target: { value: "250" } });
    expect(screen.queryByRole("button", { name: /Use code/ })).toBeNull();
    unmount();
  });

  it("adds a manual code via the disconnected-Xero fallback", () => {
    const onChange = vi.fn();
    render(
      <XeroAccountSelect accounts={[]} value="" onChange={onChange} emptyLabel="Default" ariaLabel="Account" allowManualCodes />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.change(screen.getByPlaceholderText(/Search account code/), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: /Use code/ }));
    expect(onChange).toHaveBeenCalledWith("250");
  });
});

describe("XeroItemSelect", () => {
  it("lists items and emits the chosen item code", () => {
    const onChange = vi.fn();
    render(
      <XeroItemSelect
        items={items}
        value=""
        onChange={onChange}
        emptyLabel="Default: no item"
        ariaLabel="Item"
      />,
    );
    const trigger = screen.getByRole("button", { name: "Item" });
    expect(trigger.textContent).toContain("Default: no item");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /MEMBER.*Membership/ }));
    expect(onChange).toHaveBeenCalledWith("MEMBER");
  });
});
