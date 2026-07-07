// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LodgeSelect } from "../lodge-select";

// ADR-002 single-lodge presentation rule: no lodge selector renders while
// fewer than two lodges are offered; it renders once a second lodge exists.
describe("LodgeSelect", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing and reports the sole lodge with one lodge", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect
        lodges={[{ id: "lodge-1", name: "Alpine Lodge" }]}
        value={null}
        onChange={onChange}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(onChange).toHaveBeenCalledWith("lodge-1");
  });

  it("renders nothing and reports null with no lodges", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect lodges={[]} value={"stale"} onChange={onChange} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("renders a labelled selector once a second lodge exists", () => {
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={[
          { id: "lodge-1", name: "Alpine Lodge" },
          { id: "lodge-2", name: "River Lodge" },
        ]}
        value="lodge-2"
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Lodge")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
  });

  it("defaults the selection to the first lodge when none is chosen", () => {
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={[
          { id: "lodge-1", name: "Alpine Lodge" },
          { id: "lodge-2", name: "River Lodge" },
        ]}
        value={null}
        onChange={onChange}
      />,
    );

    expect(onChange).toHaveBeenCalledWith("lodge-1");
  });

  it("holds off normalising the selection while options are loading", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect
        lodges={[]}
        value="lodge-from-url"
        onChange={onChange}
        loading
      />,
    );

    // A caller-provided initial selection (e.g. an ADR-003 hub link) must
    // survive until the options arrive.
    expect(container).toBeEmptyDOMElement();
    expect(onChange).not.toHaveBeenCalled();
  });
});
