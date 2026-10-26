import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paymentRecoveryOperation: {
      count: mocks.count,
    },
  },
}));

import { countExhaustedPaymentRecoveryOperations } from "@/lib/payment-recovery-health";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";

describe("countExhaustedPaymentRecoveryOperations (issue #821)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("MUTATION (#4104 ops 7): counts FAILED operations at the retry ceiling, and a card refund raised dead (PENDING, attempts spent)", async () => {
    mocks.count.mockResolvedValue(2);

    const result = await countExhaustedPaymentRecoveryOperations();

    expect(result).toBe(2);
    expect(mocks.count).toHaveBeenCalledWith({
      where: {
        status: { in: ["PENDING", "FAILED"] },
        attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS },
      },
    });
  });

  it("returns zero when nothing is exhausted", async () => {
    mocks.count.mockResolvedValue(0);
    await expect(countExhaustedPaymentRecoveryOperations()).resolves.toBe(0);
  });
});
