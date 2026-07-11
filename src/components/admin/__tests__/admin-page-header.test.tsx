import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminPageHeader } from "@/components/admin/admin-page-header";

describe("AdminPageHeader", () => {
  it("renders the title as the single <h1>", () => {
    const html = renderToStaticMarkup(<AdminPageHeader title="All Bookings" />);
    expect(html).toContain("<h1");
    expect(html).toContain("All Bookings");
  });

  it("renders the optional eyebrow, description, and actions slot", () => {
    const html = renderToStaticMarkup(
      <AdminPageHeader
        eyebrow="Operations"
        title="Payments"
        description="View and filter payment records"
        actions={<button type="button">Create</button>}
      />,
    );
    expect(html).toContain("Operations");
    expect(html).toContain("Payments");
    expect(html).toContain("View and filter payment records");
    expect(html).toContain("<button");
    expect(html).toContain("Create");
    // uppercase eyebrow uses a token colour, not a hardcoded gray
    expect(html).toContain("text-muted-foreground");
  });

  it("omits eyebrow, description, and actions when not provided", () => {
    const html = renderToStaticMarkup(<AdminPageHeader title="Lockers" />);
    expect(html).not.toContain("<button");
    // only the title block, no description paragraph
    expect(html).toContain("Lockers");
  });
});
