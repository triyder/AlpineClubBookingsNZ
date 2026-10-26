import { prisma } from "@/lib/prisma";
import { PAYMENT_RECOVERY_EXHAUSTED_WHERE } from "@/lib/payment-recovery-constants";

// Issue #821: a payment-recovery operation that has FAILED with attempts at the
// maximum is terminal — the claim query requires attempts < MAX, so it will
// never be retried. These need manual operator reconciliation, but the health
// check previously only counted stale PENDING work, leaving exhausted failures
// invisible. #4104: and a card refund raised dead, PENDING with its attempts spent.
export async function countExhaustedPaymentRecoveryOperations(): Promise<number> {
  return prisma.paymentRecoveryOperation.count({ where: PAYMENT_RECOVERY_EXHAUSTED_WHERE });
}
