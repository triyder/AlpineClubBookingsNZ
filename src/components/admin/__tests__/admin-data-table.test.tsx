// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdminDataTable,
  useAdminDataTableDensity,
} from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const STORAGE_KEY = "admin:data-table-density";

function SampleTable() {
  return (
    <AdminDataTable aria-label="Sample">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Alice</TableCell>
        </TableRow>
      </TableBody>
    </AdminDataTable>
  );
}

function scrollContainer(root: ParentNode) {
  return root.querySelector("[data-density]") as HTMLElement;
}

describe("AdminDataTable", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("renders its children (arbitrary columns + rows)", () => {
    render(<SampleTable />);
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("table")).toHaveAttribute("aria-label", "Sample");
  });

  it("defaults to comfortable density", () => {
    const { container } = render(<SampleTable />);
    expect(scrollContainer(container)).toHaveAttribute("data-density", "comfortable");
    expect(scrollContainer(container).className).toContain("[&_th]:h-11");
  });

  it("toggles density and persists the choice to localStorage", () => {
    const { container } = render(<SampleTable />);

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));

    const scroll = scrollContainer(container);
    expect(scroll).toHaveAttribute("data-density", "compact");
    expect(scroll.className).toContain("[&_th]:h-9");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("compact");
  });

  it("restores the persisted density after mount", () => {
    window.localStorage.setItem(STORAGE_KEY, "compact");
    const { container } = render(<SampleTable />);
    // the mount effect reconciles with the stored preference
    expect(scrollContainer(container)).toHaveAttribute("data-density", "compact");
  });

  it("stays SSR-safe: first paint ignores storage and renders the default", () => {
    // Even with a stored 'compact', the server/first-client render is
    // comfortable, so there is no hydration mismatch.
    window.localStorage.setItem(STORAGE_KEY, "compact");
    const html = renderToStaticMarkup(<SampleTable />);
    expect(html).toContain('data-density="comfortable"');
  });

  it("can hide the density toggle", () => {
    render(
      <AdminDataTable showDensityToggle={false}>
        <TableBody>
          <TableRow>
            <TableCell>Row</TableCell>
          </TableRow>
        </TableBody>
      </AdminDataTable>,
    );
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("exposes density to descendants via useAdminDataTableDensity", () => {
    function DensityProbe() {
      return <span data-testid="probe">{useAdminDataTableDensity()}</span>;
    }
    render(
      <AdminDataTable toolbar={<DensityProbe />}>
        <TableBody>
          <TableRow>
            <TableCell>Row</TableCell>
          </TableRow>
        </TableBody>
      </AdminDataTable>,
    );
    expect(screen.getByTestId("probe")).toHaveTextContent("comfortable");
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(screen.getByTestId("probe")).toHaveTextContent("compact");
  });
});
