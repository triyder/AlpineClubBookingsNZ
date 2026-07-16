import { describe, expect, it, vi } from "vitest";
import { findUnconvergedAppliedCreditDeallocation } from "@/lib/xero-applied-credit-operation-serialization";

describe("findUnconvergedAppliedCreditDeallocation", () => {
  it("blocks every non-converged deallocation status and excludes completed work", async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: "op-1",
      status: "FAILED",
    });

    const result = await findUnconvergedAppliedCreditDeallocation(
      "payment-1",
      { xeroSyncOperation: { findFirst } } as never,
    );

    expect(result).toEqual({ id: "op-1", status: "FAILED" });
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        localModel: "Payment",
        localId: "payment-1",
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        status: {
          in: ["PENDING", "RUNNING", "FAILED", "PARTIAL", "WAITING_PAYMENT"],
        },
      },
      select: { id: true, status: true },
    });
  });
});
