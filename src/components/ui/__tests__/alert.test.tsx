// @vitest-environment jsdom

import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Alert } from "@/components/ui/alert";

describe("Alert primitive", () => {
  it("pairs an aria-hidden icon with the body text for every variant", () => {
    for (const variant of ["info", "success", "warning", "error"] as const) {
      const { container, unmount } = render(
        <Alert variant={variant}>Body for {variant}</Alert>
      );
      // Status is never colour-alone: an SVG icon accompanies the text and is
      // hidden from the accessibility tree.
      const icon = container.querySelector("svg");
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      expect(screen.getByText(`Body for ${variant}`)).toBeTruthy();
      unmount();
    }
  });

  it("uses role=status for advisory variants and role=alert for assertive ones", () => {
    const { rerender } = render(<Alert variant="info">i</Alert>);
    expect(screen.getByRole("status")).toBeTruthy();

    rerender(<Alert variant="success">s</Alert>);
    expect(screen.getByRole("status")).toBeTruthy();

    rerender(<Alert variant="warning">w</Alert>);
    expect(screen.getByRole("alert")).toBeTruthy();

    rerender(<Alert variant="error">e</Alert>);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("lets an explicit role override the variant default", () => {
    render(
      <Alert variant="info" role="alert">
        overridden
      </Alert>
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders the optional title above the children", () => {
    render(
      <Alert variant="warning" title="Please verify your email">
        <p>Check your inbox.</p>
      </Alert>
    );
    const region = screen.getByRole("alert");
    expect(within(region).getByText("Please verify your email")).toBeTruthy();
    expect(within(region).getByText("Check your inbox.")).toBeTruthy();
  });

  it("forwards a ref and merges className onto the root (focus/scroll callers)", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Alert variant="error" ref={ref} tabIndex={-1} className="scroll-mt-20">
        boom
      </Alert>
    );
    expect(ref.current).not.toBeNull();
    expect(ref.current?.getAttribute("role")).toBe("alert");
    expect(ref.current?.getAttribute("tabindex")).toBe("-1");
    expect(ref.current?.className).toContain("scroll-mt-20");
  });
});
