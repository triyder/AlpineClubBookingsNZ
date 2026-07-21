// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyField } from "../copy-field";

afterEach(() => {
  vi.restoreAllMocks();
  // Reset any clipboard stub between tests.
  Object.defineProperty(navigator, "clipboard", {
    value: undefined,
    configurable: true,
  });
});

describe("CopyField (#2080)", () => {
  it("shows the value and copies via the Clipboard API, announcing success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<CopyField label="Redirect URI" value="https://club/callback" />);

    expect(screen.getByText("https://club/callback")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("https://club/callback");
    });
    await waitFor(() => {
      expect(screen.getByText(/copied to clipboard/i)).toBeTruthy();
    });
  });

  it("falls back to select-on-focus when the Clipboard API is unavailable (plain-HTTP LAN)", async () => {
    // navigator.clipboard is undefined (non-secure context) — reset in afterEach.
    const removeAllRanges = vi.fn();
    const addRange = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({
      removeAllRanges,
      addRange,
    } as unknown as Selection);

    render(<CopyField label="Client ID" value="abc123" />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    await waitFor(() => {
      expect(addRange).toHaveBeenCalled();
    });
    expect(
      screen.getByText(/press ctrl\+c or cmd\+c to copy/i),
    ).toBeTruthy();
  });

  it("shows the copy instruction VISIBLY on the fallback (sighted mouse users)", async () => {
    // No Clipboard API (undefined) and a working selection.
    vi.spyOn(window, "getSelection").mockReturnValue({
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    } as unknown as Selection);

    render(<CopyField label="Client ID" value="abc123" />);
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));

    // The button label itself becomes the instruction (visible, not only sr-only).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /press ctrl\+c/i })).toBeTruthy();
    });
    // …and a visible hint line spells it out for both platforms.
    expect(
      screen.getByText(/press ctrl\+c \(or cmd\+c on a mac\)/i),
    ).toBeTruthy();
  });

  it("names the value via aria-labelledby (a <code> takes no <label htmlFor>)", () => {
    render(<CopyField label="Redirect URI" value="https://club/callback" />);
    const value = screen.getByText("https://club/callback");
    const labelledBy = value.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const label = document.getElementById(labelledBy as string);
    expect(label?.textContent).toBe("Redirect URI");
  });

  it("renders a disabled empty state so Copy can never copy an instruction", () => {
    render(
      <CopyField
        label="OAuth 2.0 redirect URI"
        value=""
        emptyHint="Set NEXTAUTH_URL so the redirect URI can be derived."
      />,
    );
    // The instruction shows as a muted placeholder, and Copy is disabled.
    expect(
      screen.getByText(/set nextauth_url so the redirect uri/i),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /copy/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
