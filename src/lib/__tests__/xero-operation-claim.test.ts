import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    xeroSyncOperation: {
      updateMany: mocks.updateMany,
    },
  },
}));

import { claimXeroSyncOperationToRunning } from "@/lib/xero-operation-claim";

// Freeze time so the `startedAt: new Date()` in the atomic transition is
// deterministic and can be pinned exactly.
const FROZEN_NOW = new Date("2026-07-06T12:00:00.000Z");

describe("claimXeroSyncOperationToRunning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FROZEN_NOW);
    mocks.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues the exact atomic claim: PENDING precondition merged with the caller guard, and the RUNNING transition with the four resets", async () => {
    await claimXeroSyncOperationToRunning("op_1", { operationType: "REQUEUE" });

    expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    const args = mocks.updateMany.mock.calls[0][0];
    // The single-flight precondition (`status: "PENDING"`) plus the id and the
    // caller-specific guard. Pinned with `toEqual`, not a subset match, so a
    // dropped/added predicate fails here.
    expect(args.where).toEqual({
      id: "op_1",
      status: "PENDING",
      operationType: "REQUEUE",
    });
    // The money-path invariant: flip to RUNNING and clear the started/completed
    // timestamps and error fields. Any drift double-processes or mis-times a row.
    expect(args.data).toEqual({
      status: "RUNNING",
      startedAt: FROZEN_NOW,
      completedAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
  });

  it("reproduces the outbound-outbox claim WHERE byte-for-byte via the guard", async () => {
    await claimXeroSyncOperationToRunning("op_outbox", {
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: { in: ["Booking", "BookingModification"] },
    });

    expect(mocks.updateMany.mock.calls[0][0].where).toEqual({
      id: "op_outbox",
      status: "PENDING",
      direction: "OUTBOUND",
      entityType: "CREDIT_NOTE",
      operationType: "CREATE",
      localModel: { in: ["Booking", "BookingModification"] },
    });
  });

  it("claims the row when exactly one PENDING row matched", async () => {
    mocks.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      claimXeroSyncOperationToRunning("op_1", { operationType: "REQUEUE" }),
    ).resolves.toBe(true);
  });

  it("does not claim when the row was already taken (lost single-flight race)", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      claimXeroSyncOperationToRunning("op_1", { operationType: "REQUEUE" }),
    ).resolves.toBe(false);
  });

  it("returns false for any count that is not exactly one", async () => {
    mocks.updateMany.mockResolvedValue({ count: 2 });

    await expect(
      claimXeroSyncOperationToRunning("op_1", { operationType: "REQUEUE" }),
    ).resolves.toBe(false);
  });
});
