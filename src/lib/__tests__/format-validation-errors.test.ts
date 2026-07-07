import { describe, expect, it } from "vitest";
import {
  formatValidationErrorResponse,
  humanizeFieldKey,
  memberFieldLabel,
} from "@/lib/format-validation-errors";

describe("humanizeFieldKey", () => {
  it("splits camelCase into a Title-cased phrase", () => {
    expect(humanizeFieldKey("dateOfBirth")).toBe("Date of birth");
  });

  it("separates trailing digits from the word", () => {
    expect(humanizeFieldKey("streetAddressLine1")).toBe("Street address line 1");
  });

  it("handles snake_case and dotted keys", () => {
    expect(humanizeFieldKey("some_nested.field")).toBe("Some nested field");
  });
});

describe("memberFieldLabel", () => {
  it("uses the explicit friendly label for known member fields", () => {
    expect(memberFieldLabel("dateOfBirth")).toBe("Date of birth");
    expect(memberFieldLabel("email")).toBe("Email");
    expect(memberFieldLabel("phoneNumber")).toBe("Phone number");
  });

  it("falls back to a humanized label for unknown keys", () => {
    expect(memberFieldLabel("mysteryField")).toBe("Mystery field");
  });
});

describe("formatValidationErrorResponse", () => {
  it("maps a single field error to a labelled line", () => {
    const result = formatValidationErrorResponse({
      error: "Validation failed",
      details: { dateOfBirth: ["Invalid date format"] },
    });
    expect(result).toEqual(["Date of birth: Invalid date format"]);
  });

  it("returns one legible entry per field for multi-field errors", () => {
    const result = formatValidationErrorResponse({
      error: "Validation failed",
      details: {
        email: ["Invalid email address"],
        dateOfBirth: ["Invalid date format"],
      },
    });
    expect(result).toEqual([
      "Email: Invalid email address",
      "Date of birth: Invalid date format",
    ]);
  });

  it("joins multiple messages for the same field", () => {
    const result = formatValidationErrorResponse({
      details: { firstName: ["First name is required", "Too short"] },
    });
    expect(result).toEqual(["First name: First name is required; Too short"]);
  });

  it("supports the full zod flatten() shape with formErrors and fieldErrors", () => {
    const result = formatValidationErrorResponse({
      error: "Invalid query parameters",
      details: {
        formErrors: ["Something is wrong overall"],
        fieldErrors: { email: ["Invalid email address"] },
      },
    });
    expect(result).toEqual([
      "Something is wrong overall",
      "Email: Invalid email address",
    ]);
  });

  it("falls back to data.error when details are absent", () => {
    expect(
      formatValidationErrorResponse({ error: "Validation failed" }),
    ).toEqual(["Validation failed"]);
  });

  it("falls back to data.error when details carry no usable messages", () => {
    expect(
      formatValidationErrorResponse({
        error: "Validation failed",
        details: { email: [], firstName: undefined },
      }),
    ).toEqual(["Validation failed"]);
  });

  it("uses the provided default message when there is no error field", () => {
    expect(
      formatValidationErrorResponse({}, { defaultMessage: "Failed to create dependent" }),
    ).toEqual(["Failed to create dependent"]);
  });

  it("uses the generic default when nothing usable is present", () => {
    expect(formatValidationErrorResponse(null)).toEqual(["Save failed"]);
    expect(formatValidationErrorResponse(undefined)).toEqual(["Save failed"]);
  });
});
