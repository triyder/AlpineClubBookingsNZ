import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFINITIONS } from "@/lib/email-message-registry";
import { shouldPersistEmailHtml } from "@/lib/email/internal";

const REQUIRED_TOKEN_TEMPLATE_NAMES = EMAIL_TEMPLATE_DEFINITIONS.filter(
  (definition) => definition.requiredTokens.includes("token"),
).map((definition) => definition.key);

describe("sensitive EmailLog HTML classification", () => {
  it.each(REQUIRED_TOKEN_TEMPLATE_NAMES)(
    "redacts the registered token-bearing %s template",
    (templateName) => {
      expect(shouldPersistEmailHtml(templateName)).toBe(false);
    },
  );

  it("redacts the optional token-bearing chore-roster template", () => {
    expect(shouldPersistEmailHtml("chore-roster")).toBe(false);
  });

  it("redacts the split-guest payment link, whose HTML carries a live /pay/<token> link (#1967/#1994)", () => {
    // Registering the template must not weaken #1885 suppression truthfulness:
    // its rendered HTML embeds a bearer /pay/<token> link, so it must never be
    // persisted at rest in EmailLog or the retry table.
    expect(shouldPersistEmailHtml("split-guest-payment-link")).toBe(false);
  });

  it("continues to retain HTML for a non-sensitive template", () => {
    expect(shouldPersistEmailHtml("booking-request-declined")).toBe(true);
  });
});
