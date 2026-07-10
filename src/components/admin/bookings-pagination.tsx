import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

interface BookingsPaginationProps {
  page: number;
  totalPages: number;
  total: number;
  // Builds the URL for a given page, carrying the current filters/sort. Passed
  // from the server page so the component stays URL-driven (shareable links),
  // matching the sort-header links on the same page.
  hrefForPage: (page: number) => string;
}

// Windowed page numbers, same 5-slot math as MemberPagination so the two admin
// lists read the same way.
function pageWindowNumbers(page: number, totalPages: number) {
  return Array.from({ length: Math.min(5, totalPages) }, (_, index) => {
    if (totalPages <= 5) return index + 1;
    if (page <= 3) return index + 1;
    if (page >= totalPages - 2) return totalPages - 4 + index;
    return page - 2 + index;
  });
}

export function BookingsPagination({
  page,
  totalPages,
  total,
  hrefForPage,
}: BookingsPaginationProps) {
  if (totalPages <= 1) return null;

  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    <nav
      aria-label="Bookings pagination"
      className="mt-4 flex items-center justify-between border-t pt-4"
    >
      <p className="text-sm text-slate-500">
        Page {page} of {totalPages} · {total} booking{total === 1 ? "" : "s"}
      </p>
      <div className="flex gap-1">
        {atFirst ? (
          <Button variant="outline" size="sm" disabled aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link href={hrefForPage(page - 1)} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </Link>
          </Button>
        )}
        {pageWindowNumbers(page, totalPages).map((pageNumber) =>
          pageNumber === page ? (
            <Button
              key={pageNumber}
              variant="default"
              size="sm"
              aria-current="page"
              aria-label={`Page ${pageNumber}, current page`}
              disabled
            >
              {pageNumber}
            </Button>
          ) : (
            <Button key={pageNumber} variant="outline" size="sm" asChild>
              <Link href={hrefForPage(pageNumber)} aria-label={`Go to page ${pageNumber}`}>
                {pageNumber}
              </Link>
            </Button>
          )
        )}
        {atLast ? (
          <Button variant="outline" size="sm" disabled aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button variant="outline" size="sm" asChild>
            <Link href={hrefForPage(page + 1)} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        )}
      </div>
    </nav>
  );
}
