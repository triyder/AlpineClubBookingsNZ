import { Pagination } from "@/components/admin/admin-pagination";

interface BookingsPaginationProps {
  page: number;
  totalPages: number;
  total: number;
  // Builds the URL for a given page, carrying the current filters/sort. Passed
  // from the server page so the component stays URL-driven (shareable links),
  // matching the sort-header links on the same page.
  hrefForPage: (page: number) => string;
}

// Thin wrapper over the shared admin Pagination (#1805): URL mode, the same
// 5-slot window math, and the "Page N of M · X bookings" summary this list has
// always shown. Kept so `bookings/page.tsx` renders and paginates unchanged.
export function BookingsPagination({
  page,
  totalPages,
  total,
  hrefForPage,
}: BookingsPaginationProps) {
  return (
    <Pagination
      page={page}
      totalPages={totalPages}
      hrefForPage={hrefForPage}
      aria-label="Bookings pagination"
      summary={`Page ${page} of ${totalPages} · ${total} booking${total === 1 ? "" : "s"}`}
    />
  );
}
