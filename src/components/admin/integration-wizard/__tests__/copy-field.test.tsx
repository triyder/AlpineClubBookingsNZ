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
});
