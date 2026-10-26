import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { buildXeroSupplementaryInvoiceKey, isXeroSupplementaryInvoiceKeyForAnchor } from "@/lib/xero-supplementary-invoice-key";
describe("INV-SSOT-001: supplementary key mint and legacy recognition share their parts", () => {
  it.each([
    ["BookingModification", "booking-mod:anchor:supplementary-invoice:100:0:v1"],
    ["Booking", "booking:anchor:supplementary-invoice:100:0:v1"],
    ["ManualRefundTask", "review-task:anchor:supplementary-shortfall-invoice:100:0:v1"],
  ] as const)("preserves the stored %s key exactly", (localModel, expected) => {
    const key = buildXeroSupplementaryInvoiceKey({ localModel, localId: "anchor", priceDiffCents: 100, changeFeeCents: 0 });
    expect(key).toBe(expected); expect(isXeroSupplementaryInvoiceKeyForAnchor(key, localModel, "anchor")).toBe(true);
    expect(isXeroSupplementaryInvoiceKeyForAnchor(key, localModel, "other")).toBe(false);
    expect(isXeroSupplementaryInvoiceKeyForAnchor(key, "Payment", "anchor")).toBe(false);
  });
  it("does not read the primary invoice key as a supplementary", () => {
    expect(isXeroSupplementaryInvoiceKeyForAnchor("booking:anchor:invoice:v1", "Booking", "anchor")).toBe(false);
  });
});
