import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertDescriptorValid,
  isForbiddenField,
  isSensitiveOptInField,
  getRegisteredEntities,
  type EntityDescriptor,
} from "@/lib/config-transfer/registry";
// Importing the category modules registers their descriptors as a side effect
// (and runs assertDescriptorValid at load). ALL seven modules are imported so
// the forbidden-field sweep below covers every category's allowlist — not just
// site-content's.
import "@/lib/config-transfer/categories/site-content";
import "@/lib/config-transfer/categories/club-settings";
import "@/lib/config-transfer/categories/lodge-config";
import "@/lib/config-transfer/categories/lodge-ops";
import "@/lib/config-transfer/categories/committee";
import "@/lib/config-transfer/categories/induction";
import "@/lib/config-transfer/categories/xero-config";

function descriptor(overrides: Partial<EntityDescriptor> = {}): EntityDescriptor {
  return {
    entity: "lodge",
    category: "lodge-config",
    tier: "key-strong",
    format: "csv",
    file: "lodge-config/lodges.csv",
    naturalKey: ["slug"],
    singleton: false,
    fields: ["slug", "name", "active"],
    ...overrides,
  };
}

describe("config-transfer registry — forbidden field guard", () => {
  it("flags secrets, tokens, and member coupling", () => {
    expect(isForbiddenField("passwordHash")).toBe(true);
    expect(isForbiddenField("stripeSecretKey")).toBe(true);
    expect(isForbiddenField("resetToken")).toBe(true);
    expect(isForbiddenField("apiKey")).toBe(true);
    expect(isForbiddenField("updatedByMemberId")).toBe(true);
    expect(isForbiddenField("memberId")).toBe(true);
    expect(isForbiddenField("twoFactorSecret")).toBe(true);
  });

  it("does not flag ordinary config fields", () => {
    for (const f of ["slug", "name", "capacity", "sortOrder", "contentHtml"]) {
      expect(isForbiddenField(f)).toBe(false);
    }
  });

  it("treats door codes as sensitive opt-in, not forbidden", () => {
    expect(isSensitiveOptInField("doorCode")).toBe(true);
    expect(isForbiddenField("doorCode")).toBe(false);
  });
});

describe("config-transfer registry — assertDescriptorValid", () => {
  it("accepts a well-formed descriptor", () => {
    expect(() => assertDescriptorValid(descriptor())).not.toThrow();
  });

  it("rejects a forbidden field in the allowlist", () => {
    expect(() =>
      assertDescriptorValid(descriptor({ fields: ["slug", "updatedByMemberId"] })),
    ).toThrow(/forbidden field/i);
  });

  it("rejects a non-singleton with no natural key", () => {
    expect(() =>
      assertDescriptorValid(descriptor({ naturalKey: [] })),
    ).toThrow(/no natural key/i);
  });

  it("allows a singleton with no natural key", () => {
    expect(() =>
      assertDescriptorValid(
        descriptor({
          entity: "club-module-settings",
          category: "club-settings",
          format: "json",
          singleton: true,
          naturalKey: [],
          fields: ["bedAllocation", "multiLodge"],
        }),
      ),
    ).not.toThrow();
  });

  it("requires a sensitive field to be declared as opt-in", () => {
    expect(() =>
      assertDescriptorValid(
        descriptor({ fields: ["slug", "name", "doorCode"] }),
      ),
    ).toThrow(/must be declared in optInFields/i);

    expect(() =>
      assertDescriptorValid(
        descriptor({
          fields: ["slug", "name", "doorCode"],
          optInFields: ["doorCode"],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an optInField that is not in fields", () => {
    expect(() =>
      assertDescriptorValid(descriptor({ optInFields: ["doorCode"] })),
    ).toThrow(/optInField not in fields/i);
  });
});

describe("config-transfer registry — registered descriptors", () => {
  it("every category's descriptors are registered and pass the security sweep", () => {
    const entities = getRegisteredEntities();
    // One representative entity per category module proves each registered.
    expect(entities.map((e) => e.entity)).toEqual(
      expect.arrayContaining([
        "page-content",
        "site-content",
        "club-theme",
        "club-module-settings",
        "email-message-setting",
        "lodge",
        "lodge-room",
        "lodge-bed",
        "season",
        "season-rate",
        "lodge-instruction",
        "chore-template",
        "committee-role",
        "induction-template",
        "xero-account-mapping",
        "xero-item-code-mapping",
      ]),
    );
    // Every registered descriptor must satisfy the security/shape rules.
    for (const descriptor of entities) {
      expect(() => assertDescriptorValid(descriptor)).not.toThrow();
      for (const field of descriptor.fields) {
        expect(isForbiddenField(field)).toBe(false);
      }
    }
  });
});
