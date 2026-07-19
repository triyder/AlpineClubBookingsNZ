import { describe, expect, it } from "vitest";
import {
  AUTH_BOUNCE_REF_PATTERN,
  buildBookingLoginPath,
  buildLoginPath,
  getExplicitCallbackUrl,
  isValidAuthBounceRef,
  resolvePostLoginPath,
} from "@/lib/auth-redirect";

describe("auth redirect helpers", () => {
  it("keeps safe internal callback paths", () => {
    expect(resolvePostLoginPath("/nominations/token-1")).toBe("/nominations/token-1");
    expect(resolvePostLoginPath("/dashboard?tab=bookings")).toBe(
      "/dashboard?tab=bookings"
    );
  });

  it("falls back for invalid or external callback paths", () => {
    expect(resolvePostLoginPath(null)).toBe("/dashboard");
    expect(resolvePostLoginPath("https://evil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath("//evil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath("/%2f%2fevil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath("/\\\\evil.example")).toBe("/dashboard");
    expect(resolvePostLoginPath(" /dashboard")).toBe("/dashboard");
    expect(resolvePostLoginPath("/dashboard\n/admin")).toBe("/dashboard");
  });

  it("does not allow redirecting back to the login page", () => {
    expect(resolvePostLoginPath("/login")).toBe("/dashboard");
    expect(resolvePostLoginPath("/login?callbackUrl=%2Fadmin")).toBe("/dashboard");
  });

  it("builds a login URL with a preserved callback path", () => {
    expect(buildLoginPath("/nominations/token-1")).toBe(
      "/login?callbackUrl=%2Fnominations%2Ftoken-1"
    );
  });

  it("builds the booking login URL with the booking callback path", () => {
    expect(buildBookingLoginPath()).toBe("/login?callbackUrl=%2Fbook");
  });

  it("appends a valid auth-bounce ref after the callbackUrl", () => {
    expect(buildLoginPath("/nominations/token-1", "ABCD1234")).toBe(
      "/login?callbackUrl=%2Fnominations%2Ftoken-1&ref=ABCD1234"
    );
  });

  it("keeps callbackUrl first and escaped when a ref is appended", () => {
    expect(buildLoginPath("/dashboard?tab=bookings", "0A1B2C3D")).toBe(
      "/login?callbackUrl=%2Fdashboard%3Ftab%3Dbookings&ref=0A1B2C3D"
    );
  });

  it("omits the ref param when it is undefined or null", () => {
    const noRef = "/login?callbackUrl=%2Fnominations%2Ftoken-1";
    expect(buildLoginPath("/nominations/token-1")).toBe(noRef);
    expect(buildLoginPath("/nominations/token-1", undefined)).toBe(noRef);
    expect(buildLoginPath("/nominations/token-1", null)).toBe(noRef);
  });

  it("drops malformed refs and leaves the URL byte-identical to the no-ref case", () => {
    const noRef = "/login?callbackUrl=%2Fnominations%2Ftoken-1";
    // lowercase hex is not accepted
    expect(buildLoginPath("/nominations/token-1", "abcd1234")).toBe(noRef);
    // wrong length (7 and 9 chars)
    expect(buildLoginPath("/nominations/token-1", "ABCD123")).toBe(noRef);
    expect(buildLoginPath("/nominations/token-1", "ABCD12345")).toBe(noRef);
    // non-hex characters
    expect(buildLoginPath("/nominations/token-1", "GGGGGGGG")).toBe(noRef);
    // empty string
    expect(buildLoginPath("/nominations/token-1", "")).toBe(noRef);
    // query-injection attempt is rejected wholesale, not partially escaped in
    expect(buildLoginPath("/nominations/token-1", "AAAA&admin=1")).toBe(noRef);
    expect(buildLoginPath("/nominations/token-1", "AAAA&admin=1")).not.toContain(
      "admin"
    );
  });
});

describe("getExplicitCallbackUrl", () => {
  it("returns a genuinely explicit, safe internal path", () => {
    expect(getExplicitCallbackUrl("/nominations/token-1")).toBe(
      "/nominations/token-1",
    );
    expect(getExplicitCallbackUrl("/dashboard?tab=bookings")).toBe(
      "/dashboard?tab=bookings",
    );
  });

  it("returns null when absent, unsafe, or external (never a default)", () => {
    expect(getExplicitCallbackUrl(null)).toBeNull();
    expect(getExplicitCallbackUrl(undefined)).toBeNull();
    expect(getExplicitCallbackUrl("")).toBeNull();
    expect(getExplicitCallbackUrl("https://evil.example")).toBeNull();
    expect(getExplicitCallbackUrl("//evil.example")).toBeNull();
    expect(getExplicitCallbackUrl(" /dashboard")).toBeNull();
  });

  it("returns null for the login page (a flow-materialised detour URL is not explicit)", () => {
    expect(getExplicitCallbackUrl("/login")).toBeNull();
    expect(getExplicitCallbackUrl("/login?callbackUrl=%2Fadmin")).toBeNull();
  });
});

describe("isValidAuthBounceRef", () => {
  it("accepts exactly 8 uppercase hex characters", () => {
    expect(isValidAuthBounceRef("ABCD1234")).toBe(true);
    expect(isValidAuthBounceRef("00000000")).toBe(true);
    expect(isValidAuthBounceRef("FFFFFFFF")).toBe(true);
    expect(AUTH_BOUNCE_REF_PATTERN.test("0A1B2C3D")).toBe(true);
  });

  it("rejects malformed, missing, or unsafe values", () => {
    expect(isValidAuthBounceRef(undefined)).toBe(false);
    expect(isValidAuthBounceRef(null)).toBe(false);
    expect(isValidAuthBounceRef("")).toBe(false);
    expect(isValidAuthBounceRef("abcd1234")).toBe(false); // lowercase
    expect(isValidAuthBounceRef("ABCD123")).toBe(false); // too short
    expect(isValidAuthBounceRef("ABCD12345")).toBe(false); // too long
    expect(isValidAuthBounceRef("GGGGGGGG")).toBe(false); // non-hex
    expect(isValidAuthBounceRef("AAAA&admin=1")).toBe(false); // injection
    expect(isValidAuthBounceRef(" ABCD123")).toBe(false); // leading space
  });
});
