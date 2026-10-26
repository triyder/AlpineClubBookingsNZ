import { beforeEach, describe, expect, it, vi } from "vitest";

const xeroSyncErrorAlert = vi.hoisted(() => ({ notifyXeroSyncError: vi.fn() }));
vi.mock("@/lib/xero-error-alert", () => xeroSyncErrorAlert);

import { alertUnrecountedInvoices } from "@/lib/xero-inbound/recount-left-unsettled";

describe("alertUnrecountedInvoices (#4095, PR #4437 review round 3, L1)", () => {
  beforeEach(() => {
    xeroSyncErrorAlert.notifyXeroSyncError.mockReset();
  });

  it("sends nothing when every recount was written", async () => {
    await alertUnrecountedInvoices([]);
    expect(xeroSyncErrorAlert.notifyXeroSyncError).not.toHaveBeenCalled();
  });

  it("MUTATION: sends one alert naming every unrecounted invoice, because the hourly alert limit would drop a second alert", async () => {
    await alertUnrecountedInvoices([
      { invoiceId: "inv_a", message: "Invoice inv_a was settled, but correction note(s) cn_a could not be recounted against its receipt." },
      { invoiceId: "inv_b", message: "Invoice inv_b was settled, but correction note(s) cn_b could not be recounted against its receipt." },
    ]);

    expect(xeroSyncErrorAlert.notifyXeroSyncError).toHaveBeenCalledTimes(1);
    expect(xeroSyncErrorAlert.notifyXeroSyncError).toHaveBeenCalledWith({
      errorType: "refund-ledger-divergence",
      operation: "incremental-invoice-reconciliation:recount:inv_a,inv_b",
      errorMessage: expect.stringMatching(/inv_a.*cn_a.*inv_b.*cn_b.*Nothing retries them on its own/),
    });
  });
});
