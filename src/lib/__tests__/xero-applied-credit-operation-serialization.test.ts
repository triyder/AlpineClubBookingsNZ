import { describe, expect, it, vi } from "vitest";
import {
  assertNoAppliedCreditDeallocationFence,
  findUnconvergedAppliedCreditDeallocation,
} from "@/lib/xero-applied-credit-operation-serialization";

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

describe("assertNoAppliedCreditDeallocationFence", () => {
  it("fences provider-ambiguous RUNNING/FAILED work but deliberately excludes PENDING", async () => {
    const findMany = vi.fn().mockResolvedValue([{
      id: "op-1",
      status: "FAILED",
      requestPayload: { ledgerSnapshot: {} },
    }]);
    await expect(
      assertNoAppliedCreditDeallocationFence(
        "payment-1",
        { xeroSyncOperation: { findMany } } as never,
        { excludeOperationId: "self-op" },
      ),
    ).rejects.toThrow("op-1 is FAILED");
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { not: "self-op" },
        localModel: "Payment",
        localId: "payment-1",
        queueType: "APPLIED_CREDIT_DEALLOCATION",
        status: {
          in: ["PENDING", "RUNNING", "FAILED", "PARTIAL", "WAITING_PAYMENT"],
        },
      },
      select: { id: true, status: true, requestPayload: true },
      orderBy: { createdAt: "asc" },
    });
  });

  it("lets workers pass fresh PENDING but always fences checkpointed PENDING retries", async () => {
    const findMany = vi.fn()
      .mockResolvedValueOnce([{
        id: "fresh",
        status: "PENDING",
        requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION" },
      }])
      .mockResolvedValueOnce([{
        id: "retry",
        status: "PENDING",
        requestPayload: { checkpoint: { phase: "BEFORE_DELETE" } },
      }]);
    const db = { xeroSyncOperation: { findMany } } as never;
    await expect(
      assertNoAppliedCreditDeallocationFence("payment-1", db, {
        allowUncheckpointedPending: true,
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertNoAppliedCreditDeallocationFence("payment-1", db, {
        allowUncheckpointedPending: true,
      }),
    ).rejects.toThrow("retry is PENDING");
  });

  it("fences fresh PENDING for inbound/clamp writers", async () => {
    const findMany = vi.fn().mockResolvedValue([{
      id: "fresh-clamp",
      status: "PENDING",
      requestPayload: { queueType: "APPLIED_CREDIT_DEALLOCATION" },
    }]);
    await expect(
      assertNoAppliedCreditDeallocationFence(
        "payment-1",
        { xeroSyncOperation: { findMany } } as never,
      ),
    ).rejects.toThrow("fresh-clamp is PENDING");
  });
});
