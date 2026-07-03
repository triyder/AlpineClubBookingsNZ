-- #1097: persist the per-transaction refund allocation on the recovery row so
-- retries re-request exactly the unfinished slices with their original Stripe
-- idempotency keys instead of re-deriving a shifted allocation.
ALTER TABLE "PaymentRecoveryOperation" ADD COLUMN "allocationPlan" JSONB;
