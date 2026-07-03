-- #1152: persist the originating route's Stripe idempotency key prefix on
-- refund recovery operations, so a recovery replays the exact keys the route
-- used and Stripe answers a refund that succeeded-but-was-never-recorded with
-- the original refund instead of minting a new one.
ALTER TABLE "PaymentRecoveryOperation" ADD COLUMN "stripeKeyPrefix" TEXT;
