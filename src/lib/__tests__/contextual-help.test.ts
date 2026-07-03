import { describe, expect, it } from "vitest";
import {
  getContextualHelp,
  getContextualHelpPaths,
} from "@/lib/contextual-help";

describe("contextual help registry", () => {
  it("returns route-specific admin help", () => {
    const help = getContextualHelp("/admin/members", "admin");

    expect(help.title).toBe("Members");
    expect(help.fields?.map((field) => field.name)).toContain("Access role");
  });

  it("includes the booking status glossary on the bookings page help", () => {
    const help = getContextualHelp("/admin/bookings", "admin");

    const glossary = help.sections?.find(
      (section) => section.title === "Booking status glossary",
    );
    expect(glossary).toBeTruthy();
    expect(glossary?.details.some((d) => d.startsWith("Confirmed (Unpaid)"))).toBe(true);
  });

  it("uses the most specific parent route for nested admin pages", () => {
    const help = getContextualHelp("/admin/xero/setup/provider-test", "admin");

    expect(help.title).toBe("Xero Setup");
    expect(help.fields?.map((field) => field.name)).toContain("Account mapping");
  });

  it("falls back to generic admin help for unmapped admin routes", () => {
    const help = getContextualHelp("/admin/not-yet-documented", "admin");

    expect(help.title).toBe("Admin Help");
    expect(help.actions.length).toBeGreaterThan(0);
  });

  it("returns finance dashboard help for finance routes", () => {
    const help = getContextualHelp("/finance?view=revenue", "finance");

    expect(help.title).toBe("Finance Dashboard");
    expect(help.fields?.map((field) => field.name)).toContain("View");
  });

  it("covers the primary admin and finance menu surfaces", () => {
    expect(getContextualHelpPaths("admin")).toEqual(
      expect.arrayContaining([
        "/admin/dashboard",
        "/admin/bookings",
        "/admin/members",
        "/admin/site-banners",
        "/admin/xero/setup",
      ]),
    );
    expect(getContextualHelpPaths("finance")).toEqual(["/finance"]);
  });
});
