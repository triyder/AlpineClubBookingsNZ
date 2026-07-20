import { describe, it, expect } from "vitest";
import { getIgnoredEmailEnvWarning } from "../ignored-email-env";

describe("getIgnoredEmailEnvWarning", () => {
  it("returns null when no ignored email env vars are set", () => {
    expect(getIgnoredEmailEnvWarning({})).toBeNull();
    expect(
      getIgnoredEmailEnvWarning({ EMAIL_FROM: "sender@example.com" }),
    ).toBeNull();
  });

  it("treats empty / whitespace-only values as unset", () => {
    expect(
      getIgnoredEmailEnvWarning({ EMAIL_FROM_NAME: "", SUPPORT_EMAIL: "   " }),
    ).toBeNull();
  });

  it("names a single set var in the message", () => {
    const warning = getIgnoredEmailEnvWarning({
      SUPPORT_EMAIL: "support@example.com",
    });
    expect(warning).not.toBeNull();
    expect(warning!.vars).toEqual(["SUPPORT_EMAIL"]);
    expect(warning!.message).toContain("SUPPORT_EMAIL");
    expect(warning!.message).toContain("#1986");
    expect(warning!.message).toContain("Admin → Email Messages");
  });

  it("names every set var, in declaration order", () => {
    const warning = getIgnoredEmailEnvWarning({
      NEXT_PUBLIC_CONTACT_EMAIL: "contact@example.com",
      EMAIL_FROM_NAME: "Alpine Club",
      CONTACT_EMAIL: "hello@example.com",
    });
    expect(warning).not.toBeNull();
    expect(warning!.vars).toEqual([
      "EMAIL_FROM_NAME",
      "CONTACT_EMAIL",
      "NEXT_PUBLIC_CONTACT_EMAIL",
    ]);
    expect(warning!.message).toContain("EMAIL_FROM_NAME");
    expect(warning!.message).toContain("CONTACT_EMAIL");
    expect(warning!.message).toContain("NEXT_PUBLIC_CONTACT_EMAIL");
  });

  it("defaults to process.env when no env argument is given", () => {
    // Smoke: must not throw and returns either null or a well-formed warning.
    const result = getIgnoredEmailEnvWarning();
    if (result !== null) {
      expect(Array.isArray(result.vars)).toBe(true);
      expect(typeof result.message).toBe("string");
    }
  });
});
