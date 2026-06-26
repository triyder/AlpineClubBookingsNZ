// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WysiwygEditor } from "@/components/admin/page-content-panel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe("WysiwygEditor toolbar", () => {
  it("keeps the editor toolbar sticky", () => {
    render(<WysiwygEditor value="<p>Example</p>" onChange={() => {}} />);

    const modeLabel = screen.getByText("Visual editor mode is active.");
    const toolbar = modeLabel.parentElement;

    expect(toolbar).not.toBeNull();
    expect(toolbar?.className).toContain("sticky");
    expect(toolbar?.className).toContain("top-0");
    expect(toolbar?.className).toContain("z-30");
  });
});
