// #4104 review (ops 7, concurrency C): the health report's payment-recovery
// check. A card refund raised dead is PENDING with its attempts spent - never
// claimed, a person's to settle - so it counts as exhausted, never as a
// stalled cron.
import { describe, expect, it, vi } from "vitest";

const count = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    xeroConnection: { findUnique: vi.fn(async () => null) },
    paymentRecoveryOperation: { count },
  },
}));
vi.mock("@/lib/stripe-config", () => ({ getOperationalStripeSecretKey: async () => null }));
vi.mock("@/lib/email/internal", () => ({ verifyEmailTransport: async () => undefined }));

import { getDetailedHealthReport } from "@/lib/health-check";
import { MAX_PAYMENT_RECOVERY_ATTEMPTS } from "@/lib/payment-recovery-constants";

describe("the health report's payment-recovery check (#4104)", () => {
  it("MUTATION: a stale PENDING row is one the runner can still claim; exhausted counts dead PENDING rows too", async () => {
    await getDetailedHealthReport();
    const wheres = count.mock.calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);
    expect(wheres).toContainEqual(
      expect.objectContaining({ status: "PENDING", attempts: { lt: MAX_PAYMENT_RECOVERY_ATTEMPTS }, nextRetryAt: { not: null } }),
    );
    expect(wheres).toContainEqual({ status: { in: ["PENDING", "FAILED"] }, attempts: { gte: MAX_PAYMENT_RECOVERY_ATTEMPTS } });
  });
});
