import { describe, expect, it } from "vitest";
import {
  canUnpublishPage,
  isBuiltinPageSlug,
  isReservedPageSlug,
  isValidPageSlug,
  normalizePageSlug,
  toPagePath,
} from "@/lib/page-content";

describe("normalizePageSlug", () => {
  it("trims, lowercases, and strips surrounding slashes", () => {
    expect(normalizePageSlug("  /Trip-Reports/  ")).toBe("trip-reports");
  });

  it("collapses repeated slashes between segments", () => {
    expect(normalizePageSlug("join//apply")).toBe("join/apply");
  });
});

describe("isValidPageSlug", () => {
  it("accepts single-segment slugs", () => {
    expect(isValidPageSlug("trip-reports")).toBe(true);
    expect(isValidPageSlug("about")).toBe(true);
    expect(isValidPageSlug("2026-agm")).toBe(true);
  });

  it("accepts multi-segment slugs", () => {
    expect(isValidPageSlug("join/apply")).toBe(true);
    expect(isValidPageSlug("trips/2026/ruapehu")).toBe(true);
  });

  it("rejects malformed slugs", () => {
    expect(isValidPageSlug("")).toBe(false);
    expect(isValidPageSlug("Trip-Reports")).toBe(false);
    expect(isValidPageSlug("-leading")).toBe(false);
    expect(isValidPageSlug("trailing-")).toBe(false);
    expect(isValidPageSlug("/leading-slash")).toBe(false);
    expect(isValidPageSlug("trailing-slash/")).toBe(false);
    expect(isValidPageSlug("two//slashes")).toBe(false);
    expect(isValidPageSlug("has space")).toBe(false);
    expect(isValidPageSlug("under_score")).toBe(false);
  });
});

describe("isReservedPageSlug", () => {
  it("rejects reserved names as a whole slug", () => {
    expect(isReservedPageSlug("admin")).toBe(true);
    expect(isReservedPageSlug("api")).toBe(true);
    expect(isReservedPageSlug("login")).toBe(true);
  });

  it("rejects reserved names in any segment position", () => {
    expect(isReservedPageSlug("admin/settings")).toBe(true);
    expect(isReservedPageSlug("api/pages")).toBe(true);
    expect(isReservedPageSlug("trips/book")).toBe(true);
  });

  it("allows non-reserved slugs, including code-backed page slugs", () => {
    expect(isReservedPageSlug("about")).toBe(false);
    expect(isReservedPageSlug("join/apply")).toBe(false);
    expect(isReservedPageSlug("contact")).toBe(false);
    expect(isReservedPageSlug("home")).toBe(false);
    expect(isReservedPageSlug("rules")).toBe(false);
    expect(isReservedPageSlug("privacy")).toBe(false);
    expect(isReservedPageSlug("terms")).toBe(false);
    expect(isReservedPageSlug("faq")).toBe(false);
  });
});

describe("toPagePath", () => {
  it("prefixes the slug with a slash", () => {
    expect(toPagePath("about")).toBe("/about");
    expect(toPagePath("join/apply")).toBe("/join/apply");
  });
});

describe("isBuiltinPageSlug", () => {
  it("recognises seeded, code-linked pages", () => {
    expect(isBuiltinPageSlug("home")).toBe(true);
    expect(isBuiltinPageSlug("about")).toBe(true);
    expect(isBuiltinPageSlug("join/apply")).toBe(true);
    expect(isBuiltinPageSlug("committee")).toBe(true);
    expect(isBuiltinPageSlug("privacy")).toBe(true);
    expect(isBuiltinPageSlug("terms")).toBe(true);
    expect(isBuiltinPageSlug("faq")).toBe(true);
  });

  it("does not match admin-created pages", () => {
    expect(isBuiltinPageSlug("trip-reports")).toBe(false);
    expect(isBuiltinPageSlug("2026-agm")).toBe(false);
  });
});

describe("canUnpublishPage", () => {
  it("allows hiding only admin-created pages", () => {
    expect(canUnpublishPage("trip-reports")).toBe(true);
    expect(canUnpublishPage("2026-agm")).toBe(true);
  });

  it("never allows hiding system or built-in pages", () => {
    expect(canUnpublishPage("home")).toBe(false);
    expect(canUnpublishPage("404")).toBe(false);
    expect(canUnpublishPage("about")).toBe(false);
    expect(canUnpublishPage("join/apply")).toBe(false);
    expect(canUnpublishPage("contact")).toBe(false);
    expect(canUnpublishPage("privacy")).toBe(false);
    expect(canUnpublishPage("terms")).toBe(false);
    expect(canUnpublishPage("faq")).toBe(false);
  });
});
