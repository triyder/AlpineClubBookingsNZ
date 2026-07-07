import { describe, expect, it } from "vitest";
import { buildXeroReportsUrl } from "@/lib/xero-links";

describe("buildXeroReportsUrl", () => {
  it("links to the session-scoped Xero report centre without a short code", () => {
    expect(buildXeroReportsUrl()).toBe("https://go.xero.com/Reports/");
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroReportsUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2FReports%2F"
    );
  });
});
