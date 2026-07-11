// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, within } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SortHeader } from "@/components/admin/sort-header";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: { children: ReactNode; href: string } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// <th> must live inside a table for valid DOM; wrap so aria-sort lands on a
// real header cell.
function renderHeader(node: ReactNode) {
  return render(
    <table>
      <thead>
        <tr>{node}</tr>
      </thead>
    </table>,
  );
}

describe("SortHeader", () => {
  it("inactive: aria-sort none and the neutral up/down glyph", () => {
    const { container } = renderHeader(
      <SortHeader active={false} direction="asc" href="/admin/bookings?sortBy=member&sortDir=asc">
        Member
      </SortHeader>,
    );
    const th = container.querySelector("th")!;
    expect(th).toHaveAttribute("aria-sort", "none");
    expect(container.querySelector(".lucide-arrow-up-down")).not.toBeNull();
    expect(container.querySelector(".lucide-arrow-up")).toBeNull();
    expect(container.querySelector(".lucide-arrow-down")).toBeNull();
  });

  it("active ascending: aria-sort ascending and the up arrow", () => {
    const { container } = renderHeader(
      <SortHeader active direction="asc" href="/x">
        Check In
      </SortHeader>,
    );
    expect(container.querySelector("th")).toHaveAttribute("aria-sort", "ascending");
    expect(container.querySelector(".lucide-arrow-up")).not.toBeNull();
    expect(container.querySelector(".lucide-arrow-up-down")).toBeNull();
  });

  it("active descending: aria-sort descending and the down arrow", () => {
    const { container } = renderHeader(
      <SortHeader active direction="desc" href="/x">
        Check In
      </SortHeader>,
    );
    expect(container.querySelector("th")).toHaveAttribute("aria-sort", "descending");
    expect(container.querySelector(".lucide-arrow-down")).not.toBeNull();
    expect(container.querySelector(".lucide-arrow-up-down")).toBeNull();
  });

  it("URL mode renders a link to the supplied href", () => {
    const { container } = renderHeader(
      <SortHeader active={false} direction="asc" href="/admin/bookings?sortBy=total&sortDir=desc">
        Total
      </SortHeader>,
    );
    const link = within(container.querySelector("th")!).getByRole("link");
    expect(link).toHaveAttribute("href", "/admin/bookings?sortBy=total&sortDir=desc");
  });

  it("callback mode renders a button and fires onSort", () => {
    const onSort = vi.fn();
    const { container } = renderHeader(
      <SortHeader active direction="asc" onSort={onSort}>
        Amount
      </SortHeader>,
    );
    const button = within(container.querySelector("th")!).getByRole("button");
    fireEvent.click(button);
    expect(onSort).toHaveBeenCalledTimes(1);
  });
});
