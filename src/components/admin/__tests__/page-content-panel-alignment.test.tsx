// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { applyTextAlignmentToSelection } from "../page-content-panel";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe("applyTextAlignmentToSelection", () => {
  it("applies alignment classes without inline styles", () => {
    document.body.innerHTML = '<div id="editor"><p>Aligned text</p></div>';
    const editor = document.getElementById("editor") as HTMLDivElement;
    const paragraph = editor.querySelector("p") as HTMLParagraphElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = applyTextAlignmentToSelection(editor, selection!, "center");

    expect(result).toBe(true);
    expect(paragraph.className).toBe("wysiwyg-align-center");
    expect(paragraph.getAttribute("style")).toBeNull();
    expect(editor.innerHTML).toBe(
      '<p class="wysiwyg-align-center">Aligned text</p>',
    );
  });

  it("switches alignment classes cleanly", () => {
    document.body.innerHTML =
      '<div id="editor"><p class="wysiwyg-align-center">Aligned text</p></div>';
    const editor = document.getElementById("editor") as HTMLDivElement;
    const paragraph = editor.querySelector("p") as HTMLParagraphElement;
    const range = document.createRange();
    range.selectNodeContents(paragraph);

    const selection = window.getSelection();
    expect(selection).not.toBeNull();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const result = applyTextAlignmentToSelection(editor, selection!, "right");

    expect(result).toBe(true);
    expect(paragraph.className).toBe("wysiwyg-align-right");
    expect(editor.innerHTML).toBe(
      '<p class="wysiwyg-align-right">Aligned text</p>',
    );
  });
});
