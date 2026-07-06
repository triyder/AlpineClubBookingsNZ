import { beforeEach, describe, expect, it, vi } from "vitest";

// -----------------------------------------------------------------------------
// F4 (#1354): the outbox processor must mark an operation FAILED for EVERY
// queue type when its handler throws — not only the two membership-cancellation
// types. An operation erroring before its handler overwrote requestPayload
// previously stayed RUNNING; after an operator stale-reset the retry stack
// could not parse the queued payload shape — a permanent dead-end.
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  operationFindMany: vi.fn(),
  operationUpdateMany: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  createXeroCreditNote: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      findMany: mocks.operationFindMany,
      // The single-flight claim (PENDING -> RUNNING) succeeds.
      updateMany: mocks.operationUpdateMany,
    },
  },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
  };
});

vi.mock("@/lib/xero-credit-notes", () => ({
  createXeroCreditNote: mocks.createXeroCreditNote,
  createUnappliedXeroCreditNote: vi.fn(),
  createXeroCreditNoteForModification: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { processQueuedXeroOutboxOperations } from "@/lib/xero-operation-outbox";

describe("outbox processor fail-fast for all queue types (#1354)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.failXeroSyncOperation.mockResolvedValue(undefined);
    mocks.operationUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("marks a refund-credit-note operation FAILED when its handler throws before the payload overwrite", async () => {
    mocks.operationFindMany.mockResolvedValue([
      {
        id: "op_refund_1",
        localModel: "Payment",
        localId: "pay_1",
        requestPayload: {
          queueType: "REFUND_CREDIT_NOTE",
          refundAmountCents: 3000,
          watermarkCents: 8000,
        },
      },
    ]);
    // Token refresh / contact resolution / account mapping failures all
    // surface as a thrown error from the handler, BEFORE requestPayload is
    // overwritten with the Xero request shape.
    mocks.createXeroCreditNote.mockRejectedValue(
      new Error("Xero token refresh failed")
    );

    const result = await processQueuedXeroOutboxOperations({ limit: 1 });

    expect(result).toMatchObject({ found: 1, failed: 1, succeeded: 0 });
    // Pre-#1354 this operation stayed RUNNING (only the two
    // membership-cancellation types were failed); now it is replayable.
    expect(mocks.failXeroSyncOperation).toHaveBeenCalledWith(
      "op_refund_1",
      expect.objectContaining({ message: "Xero token refresh failed" })
    );
  });
});
