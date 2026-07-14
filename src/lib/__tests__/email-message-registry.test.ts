import { describe, expect, it } from "vitest";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  SENSITIVE_EMAIL_SUBJECT_TOKEN_SET,
  getSensitiveEmailSubjectTokens,
  getDefaultDeliveryMode,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import {
  neutraliseSensitiveSubjectContent,
  renderTemplateString,
  validateApprovedTemplateTokens,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";

describe("email message registry", () => {
  it("uses content-only defaults for noisy scheduled report emails", () => {
    expect(getDefaultDeliveryMode("admin-daily-digest")).toBe("content_only");
    expect(getDefaultDeliveryMode("admin-xero-reconciliation-report")).toBe(
      "content_only",
    );
    expect(getDefaultDeliveryMode("admin-payment-failure")).toBe("always");
  });

  it("has editor-safe defaults for every registered template", () => {
    const invalidDefinitions = EMAIL_TEMPLATE_DEFINITIONS.flatMap((definition) => {
      const validation = validateEmailTemplateContent({
        templateName: definition.key,
        subject: definition.defaultSubject,
        bodyText: definition.defaultBody,
      });

      return validation.valid
        ? []
        : [{ key: definition.key, issues: validation.issues }];
    });

    expect(invalidDefinitions).toEqual([]);
  });

  it("allows age-up invitation wording to use configured age-tier data", () => {
    const ageUpDefinition = EMAIL_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.key === "age-up-invitation",
    );

    expect(ageUpDefinition?.allowedTokens).toEqual(
      expect.arrayContaining([
        "targetAgeTier",
        "targetAgeTierLabel",
        "targetAgeTierMinAge",
      ]),
    );
  });

  it("registers the age-up parent email handoff template as editor-safe", () => {
    const handoffDefinition = EMAIL_TEMPLATE_DEFINITIONS.find(
      (definition) => definition.key === "age-up-parent-email-handoff",
    );

    expect(handoffDefinition).toBeDefined();
    expect(handoffDefinition?.allowedTokens).toEqual(
      expect.arrayContaining([
        "memberName",
        "recipientName",
        "targetAgeTier",
        "targetAgeTierLabel",
        "targetAgeTierMinAge",
      ]),
    );
    expect(handoffDefinition?.requiredTokens).toContain("memberName");
  });

  it("rejects unapproved template tokens", () => {
    expect(validateApprovedTemplateTokens(["Hi {{firstName}}"])).toEqual([]);
    expect(validateApprovedTemplateTokens(["Hi {{secretTokenValue}}"])).toEqual([
      "secretTokenValue",
    ]);
  });

  it("rejects template tokens that are not allowed for that message", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Reset your password",
      bodyText: "Hi {{memberName}}, reset here {{BASE_URL}}/reset-password?token={{token}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.disallowedTokens).toContain("memberName");
  });

  it("rejects missing required tokens", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Reset your password",
      bodyText: "Please contact support.",
    });

    expect(validation.valid).toBe(false);
    expect(validation.missingRequiredTokens).toContain("token");
  });

  it("accepts required tokens that appear only in the body", () => {
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Your booking is confirmed",
      bodyText:
        "Hi {{firstName}}, see you soon.\n\n{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it("does not let subject tokens satisfy required body tokens", () => {
    const validation = validateEmailTemplateContent({
      templateName: "age-up-parent-email-handoff",
      subject: "Update about {{memberName}}",
      bodyText: "Hello, an account update has occurred.",
    });

    expect(validation.valid).toBe(false);
    expect(validation.missingRequiredTokens).toContain("memberName");
  });

  it("skips required token checks when the body override is empty", () => {
    // An empty body override falls back to the default body, which already
    // carries the required tokens.
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Your booking is confirmed",
      bodyText: "",
    });

    expect(validation.valid).toBe(true);
    expect(validation.missingRequiredTokens).toEqual([]);
  });

  it("rejects the door code token in subject lines", () => {
    const validation = validateEmailTemplateContent({
      templateName: "booking-confirmed",
      subject: "Door code {{doorCode}}",
      bodyText: "{{CLUB_LODGE_TRAVEL_NOTE}}\n\nDoor code: {{doorCode}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.sensitiveSubjectTokens).toEqual(["doorCode"]);
    expect(validation.issues.map((issue) => issue.code)).toContain(
      "sensitive_subject_token",
    );
  });

  it("rejects credential tokens in subject lines", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Your reset code is {{token}}",
      bodyText: "Reset here {{BASE_URL}}/reset-password?token={{token}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.sensitiveSubjectTokens).toEqual(["token"]);
  });

  it("classifies every bearer-link data alias as subject-sensitive", () => {
    expect(
      [
        "choreLink",
        "claimUrl",
        "confirmUrl",
        "confirmationUrl",
        "payUrl",
        "resetUrl",
        "respondUrl",
        "verifyUrl",
      ].filter((token) => !SENSITIVE_EMAIL_SUBJECT_TOKEN_SET.has(token)),
    ).toEqual([]);
    expect(
      getSensitiveEmailSubjectTokens("nomination-request").has("reviewUrl"),
    ).toBe(true);
    expect(
      getSensitiveEmailSubjectTokens("admin-booking-request-pending").has(
        "reviewUrl",
      ),
    ).toBe(false);
  });

  it("strips sensitive placeholders and live values from rendered subjects", () => {
    expect(
      neutraliseSensitiveSubjectContent("Door code {{doorCode}} is 97531", {
        doorCode: "97531",
      }),
    ).toBe("Door code is");
    expect(
      neutraliseSensitiveSubjectContent("Booking Confirmed - Example Lodge", {
        doorCode: "97531",
      }),
    ).toBe("Booking Confirmed - Example Lodge");
  });

  it("rejects subject line breaks, raw HTML, and unsafe links", () => {
    const validation = validateEmailTemplateContent({
      templateName: "password-reset",
      subject: "Reset\nPassword",
      bodyText:
        "<strong>Reset</strong> javascript:alert(1) {{BASE_URL}}/reset-password?token={{token}}",
    });

    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["subject_line_break", "raw_html", "unsafe_link"]),
    );
  });

  it("renders known tokens and drops missing values", () => {
    expect(
      renderTemplateString("Hi {{firstName}} {{missing}}", {
        firstName: "Ada",
      }),
    ).toBe("Hi Ada ");
  });
});

// #1797: the 11 previously-hardcoded senders are now wording-editable via
// EMAIL_AUDIT_DEFAULTS, but their delivery must stay locked (always send).
// two-factor-code is deliberately excluded and stays hardcoded.
const NEWLY_REGISTERED_HARDCODED_KEYS = [
  "booking-review-approved",
  "booking-review-rejected",
  "induction-sign-off-request",
  "school-attendee-confirmation",
  "admin-school-manual-invoice",
  "group-booking-join-verification",
  "group-settlement-receipt",
  "group-join-settled",
  "group-settlement-expired",
  "group-join-released",
  "group-join-cancelled",
] as const;

// The subset that carries an essential action link (required body token).
const ACTION_LINK_KEYS = [
  "booking-review-approved",
  "induction-sign-off-request",
  "school-attendee-confirmation",
  "group-booking-join-verification",
] as const;

describe("newly-registered hardcoded email templates (#1797)", () => {
  it.each(NEWLY_REGISTERED_HARDCODED_KEYS)(
    "registers %s as wording-editable but delivery-locked (always send)",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing definition for ${key}`);

      // Hard safety invariant: these are member-facing (some carry action
      // links), so wording is editable but delivery must never become
      // admin-disable-able — deliveryEditable stays false and the default
      // delivery mode stays "always", matching today's unconditional send.
      expect(definition.deliveryEditable).toBe(false);
      expect(getDefaultDeliveryMode(key)).toBe("always");
    },
  );

  it.each(NEWLY_REGISTERED_HARDCODED_KEYS)(
    "keeps every required token of %s present in its default body",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing definition for ${key}`);

      for (const token of definition.requiredTokens) {
        expect(definition.defaultBody).toContain(`{{${token}}}`);
      }
    },
  );

  it("does not confuse two-factor-code as editable (stays hardcoded)", () => {
    expect(getEmailTemplateDefinition("two-factor-code")).toBeUndefined();
  });

  it("classifies admin-school-manual-invoice as an admin alert but keeps it delivery-locked", () => {
    // It ships via sendToAdmins, so it must classify as an admin alert like its
    // siblings (audience "admin") rather than "member". It stays in
    // LOCKED_DELIVERY_TEMPLATE_NAMES so admins still cannot disable it —
    // disabling would let an approved school booking go un-invoiced (#1797).
    const definition = getEmailTemplateDefinition("admin-school-manual-invoice");
    if (!definition) throw new Error("missing admin-school-manual-invoice");
    expect(definition.audience).toBe("admin");
    expect(definition.deliveryEditable).toBe(false);
    expect(getDefaultDeliveryMode("admin-school-manual-invoice")).toBe("always");
  });
});

describe("render path for newly-registered action-link templates (#1797)", () => {
  it.each(ACTION_LINK_KEYS)(
    "renders %s default body from sample data with no unresolved placeholders",
    (key) => {
      const definition = getEmailTemplateDefinition(key);
      if (!definition) throw new Error(`missing definition for ${key}`);

      // This is the override render path an admin edit takes:
      // prepareEmailMessage feeds a stored bodyText through renderTemplateString
      // with the send's templateData. Proving the default body renders cleanly
      // from sampleData proves the required action token substitutes correctly.
      const rendered = renderTemplateString(
        definition.defaultBody,
        definition.sampleData,
      );

      for (const token of definition.requiredTokens) {
        const sample = definition.sampleData[token];
        expect(sample).toBeTruthy();
        expect(rendered).toContain(String(sample));
        expect(rendered).not.toContain(`{{${token}}}`);
      }

      // Every token in the default body has a sample value, so nothing is left
      // as an unrendered {{placeholder}} (bracket annotations are plain text).
      expect(rendered).not.toMatch(/\{\{[^{}]+\}\}/);
    },
  );
});
