// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { Pagination, pageWindowNumbers } from "@/components/admin/admin-pagination";

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

describe("pageWindowNumbers (5-slot window math)", () => {
  it("returns every page when there are five or fewer", () => {
    expect(pageWindowNumbers(1, 3)).toEqual([1, 2, 3]);
    expect(pageWindowNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("clamps to the leading window near the start", () => {
    expect(pageWindowNumbers(1, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindowNumbers(3, 10)).toEqual([1, 2, 3, 4, 5]);
  });

  it("centres on the current page in the middle", () => {
    expect(pageWindowNumbers(5, 10)).toEqual([3, 4, 5, 6, 7]);
  });

  it("clamps to the trailing window near the end", () => {
    expect(pageWindowNumbers(10, 10)).toEqual([6, 7, 8, 9, 10]);
  });
});

describe("Pagination — URL mode", () => {
  const hrefForPage = (p: number) => `?page=${p}`;

  it("renders the default summary and windowed page links", () => {
    render(<Pagination page={2} totalPages={5} hrefForPage={hrefForPage} />);
    expect(screen.getByText("Page 2 of 5")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Previous page" })).toHaveAttribute(
      "href",
      "?page=1",
    );
    expect(screen.getByRole("link", { name: "Go to page 3" })).toHaveAttribute(
      "href",
      "?page=3",
    );
    expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
      "href",
      "?page=3",
    );
  });

  it("marks the current page as aria-current and disabled", () => {
    render(<Pagination page={2} totalPages={5} hrefForPage={hrefForPage} />);
    const current = screen.getByRole("button", { name: "Page 2, current page" });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toBeDisabled();
  });

  it("accepts a custom summary node (bookings-style count)", () => {
    render(
      <Pagination
        page={1}
        totalPages={3}
        hrefForPage={hrefForPage}
        summary="Page 1 of 3 · 42 bookings"
      />,
    );
    expect(screen.getByText("Page 1 of 3 · 42 bookings")).toBeInTheDocument();
  });

  it("disables the previous control on the first page", () => {
    render(<Pagination page={1} totalPages={5} hrefForPage={hrefForPage} />);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });
});

describe("Pagination — callback mode", () => {
  it("calls onPageChange with the target page number", () => {
    const onPageChange = vi.fn();
    render(<Pagination page={2} totalPages={5} onPageChange={onPageChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);

    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(3);
  });
});

describe("Pagination — page-size selector", () => {
  it("callback mode: fires onPageSizeChange and marks the current size", () => {
    const onPageSizeChange = vi.fn();
    render(
      <Pagination
        page={1}
        totalPages={1}
        pageSize={25}
        onPageChange={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    // shown even with a single page because a size handler is present
    const current = screen.getByRole("button", { name: "25 rows per page, current" });
    expect(current).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Show 50 rows per page" }));
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it("URL mode: renders page-size links", () => {
    render(
      <Pagination
        page={1}
        totalPages={3}
        pageSize={25}
        hrefForPage={(p) => `?page=${p}`}
        hrefForPageSize={(s) => `?size=${s}`}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Show 50 rows per page" }),
    ).toHaveAttribute("href", "?size=50");
  });

  it("honours custom page-size options", () => {
    render(
      <Pagination
        page={1}
        totalPages={1}
        pageSize={20}
        pageSizeOptions={[20, 40]}
        onPageChange={vi.fn()}
        onPageSizeChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Show 40 rows per page" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show 50 rows per page" })).toBeNull();
  });
});

describe("Pagination — empty states", () => {
  it("renders nothing for a single page with no page-size selector", () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} hrefForPage={(p) => `?page=${p}`} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
