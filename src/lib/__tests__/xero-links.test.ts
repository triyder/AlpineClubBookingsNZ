import { describe, expect, it } from "vitest";
import { buildXeroReportsUrl } from "@/lib/xero-links";

describe("buildXeroReportsUrl", () => {
  it("links to the Xero report centre without a short code", () => {
    expect(buildXeroReportsUrl()).toBe("https://go.xero.com/app/reports");
  });

  it("routes through organisation login when a short code is available", () => {
    expect(buildXeroReportsUrl({ shortCode: "!aBc12" })).toBe(
      "https://go.xero.com/organisationlogin/default.aspx?shortcode=!aBc12&redirecturl=%2Fapp%2Freports"
    );
  });
});
