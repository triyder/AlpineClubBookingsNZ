import { describe, expect, it } from "vitest";
import {
  canonicalXeroWebhookEventCategory,
  inboundEventCategoriesForXeroObjectType,
  inboundEventCategoryFilter,
  xeroInboundCategoryFilterValue,
  xeroWebhookEventCategorySpellings,
} from "@/lib/xero-webhook-categories";

describe("Xero webhook categories", () => {
  it("treats Xero's CREDITNOTE and the historical CREDIT_NOTE spelling as one category", () => {
    expect(canonicalXeroWebhookEventCategory("CREDITNOTE")).toBe("CREDITNOTE");
    expect(canonicalXeroWebhookEventCategory(" credit_note ")).toBe("CREDITNOTE");
    expect(canonicalXeroWebhookEventCategory("INVOICE")).toBe("INVOICE");
    expect(canonicalXeroWebhookEventCategory("  ")).toBeNull();
    expect(canonicalXeroWebhookEventCategory(null)).toBeNull();
  });

  it("looks up a credit-note link under both stored spellings", () => {
    expect(inboundEventCategoriesForXeroObjectType("CREDIT_NOTE")).toEqual([
      "CREDITNOTE",
      "CREDIT_NOTE",
    ]);
    expect(xeroWebhookEventCategorySpellings("CREDIT_NOTE")).toEqual([
      "CREDITNOTE",
      "CREDIT_NOTE",
    ]);
    expect(inboundEventCategoryFilter("CREDITNOTE")).toEqual({
      eventCategory: { in: ["CREDITNOTE", "CREDIT_NOTE"] },
    });
    expect(inboundEventCategoryFilter("INVOICE")).toEqual({ eventCategory: "INVOICE" });
    expect(xeroInboundCategoryFilterValue("CREDIT_NOTE")).toBe("CREDITNOTE");
    expect(inboundEventCategoriesForXeroObjectType("SUBSCRIPTION")).toEqual(["INVOICE"]);
  });
});
