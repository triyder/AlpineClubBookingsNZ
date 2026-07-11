// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Inbox } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";

import { EmptyState } from "../empty-state";
import { Spinner } from "../spinner";

afterEach(() => cleanup());

describe("Spinner", () => {
  it("exposes a live status region with a single visually-hidden label", () => {
    render(<Spinner />);
    const status = screen.getByRole("status");
    // The label is announced via the sr-only text; the status region itself
    // carries no competing aria-label (avoids double announcement).
    expect(status).not.toHaveAttribute("aria-label");
    expect(screen.getByText("Loading…")).toHaveClass("sr-only");
  });

  it("marks the animated icon aria-hidden so only the text is announced", () => {
    const { container } = render(<Spinner label="Loading reports…" />);
    expect(screen.getByText("Loading reports…")).toBeInTheDocument();
    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    // animate-spin is collapsed by the global reduced-motion guard but the icon
    // stays rendered as a static indicator.
    expect(icon).toHaveClass("animate-spin");
  });

  it("applies the requested size", () => {
    const { container } = render(<Spinner size="lg" />);
    expect(container.querySelector("svg")).toHaveClass("h-8", "w-8");
  });
});

describe("EmptyState", () => {
  it("renders an h2 heading by default with title and direction", () => {
    render(
      <EmptyState
        icon={Inbox}
        title="No members yet"
        description="Members you add will appear here."
      />,
    );
    const heading = screen.getByRole("heading", { level: 2, name: "No members yet" });
    expect(heading).toBeInTheDocument();
    expect(
      screen.getByText("Members you add will appear here."),
    ).toBeInTheDocument();
  });

  it("honours a configurable heading level", () => {
    render(<EmptyState title="Nothing here" headingLevel={3} />);
    expect(
      screen.getByRole("heading", { level: 3, name: "Nothing here" }),
    ).toBeInTheDocument();
  });

  it("renders the action slot and hides the icon from assistive tech", () => {
    const { container } = render(
      <EmptyState
        icon={Inbox}
        title="No results"
        action={<button type="button">Add member</button>}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Add member" }),
    ).toBeInTheDocument();
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
