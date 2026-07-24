import { describe, expect, it } from "vitest";
import { memberPhotoServingUrl } from "@/lib/member-photo-url";

describe("memberPhotoServingUrl", () => {
  it("resolves to the scoped member endpoint, never the public content path", () => {
    const url = memberPhotoServingUrl("mem-123");
    expect(url).toBe("/api/members/mem-123/photo");
    expect(url).not.toContain("/api/images");
  });

  it("appends a cache-busting version when provided", () => {
    expect(memberPhotoServingUrl("mem-1", "2026-07-17T00:00:00.000Z")).toBe(
      "/api/members/mem-1/photo?v=2026-07-17T00%3A00%3A00.000Z",
    );
    expect(memberPhotoServingUrl("mem-1", 42)).toBe(
      "/api/members/mem-1/photo?v=42",
    );
  });

  it("omits the query for null, undefined, or empty versions", () => {
    expect(memberPhotoServingUrl("mem-1", null)).toBe(
      "/api/members/mem-1/photo",
    );
    expect(memberPhotoServingUrl("mem-1", undefined)).toBe(
      "/api/members/mem-1/photo",
    );
    expect(memberPhotoServingUrl("mem-1", "")).toBe("/api/members/mem-1/photo");
  });

  it("encodes the member id so a hostile id cannot break out of the path", () => {
    const url = memberPhotoServingUrl("../images/secret");
    expect(url).toBe("/api/members/..%2Fimages%2Fsecret/photo");
    expect(url).not.toContain("/api/images");
  });
});
