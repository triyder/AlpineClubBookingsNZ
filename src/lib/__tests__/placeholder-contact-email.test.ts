import { describe, it, expect } from "vitest";
import {
  buildPlaceholderContactEmail,
  isPlaceholderContactEmail,
  PLACEHOLDER_CONTACT_EMAIL_DOMAIN,
} from "@/lib/placeholder-contact-email";

describe("placeholder-contact-email (#1935)", () => {
  it("mints unique addresses on the reserved .invalid domain", () => {
    const a = buildPlaceholderContactEmail();
    const b = buildPlaceholderContactEmail();
    expect(a).not.toBe(b);
    expect(a.endsWith(`@${PLACEHOLDER_CONTACT_EMAIL_DOMAIN}`)).toBe(true);
    expect(PLACEHOLDER_CONTACT_EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
  });

  it("detects placeholders case/whitespace-insensitively", () => {
    expect(isPlaceholderContactEmail(buildPlaceholderContactEmail())).toBe(true);
    expect(isPlaceholderContactEmail("  Walk-In-X@No-Email.Invalid  ")).toBe(true);
    expect(isPlaceholderContactEmail("real.person@example.com")).toBe(false);
    expect(isPlaceholderContactEmail("")).toBe(false);
    expect(isPlaceholderContactEmail(null)).toBe(false);
    expect(isPlaceholderContactEmail(undefined)).toBe(false);
  });
});
