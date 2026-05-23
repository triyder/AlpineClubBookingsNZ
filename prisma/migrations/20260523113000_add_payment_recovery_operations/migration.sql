-- CreateEnum
CREATE TYPE "PaymentRecoveryOperationType" AS ENUM ('CANCEL_PAYMENT_INTENT', 'REFUND_SUPERSEDED_PAYMENT');

-- CreateEnum
CREATE TYPE "PaymentRecoveryOperationStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "PaymentRecoveryOperation" (
    "id" TEXT NOT NULL,
    "type" "PaymentRecoveryOperationType" NOT NULL,
    "status" "PaymentRecoveryOperationStatus" NOT NULL DEFAULT 'PENDING',
    "bookingId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "paymentTransactionId" TEXT,
    "paymentIntentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentRecoveryOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentRecoveryOperation_idempotencyKey_key" ON "PaymentRecoveryOperation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PaymentRecoveryOperation_bookingId_idx" ON "PaymentRecoveryOperation"("bookingId");

-- CreateIndex
CREATE INDEX "PaymentRecoveryOperation_paymentId_idx" ON "PaymentRecoveryOperation"("paymentId");

-- CreateIndex
CREATE INDEX "PaymentRecoveryOperation_paymentTransactionId_idx" ON "PaymentRecoveryOperation"("paymentTransactionId");

-- CreateIndex
CREATE INDEX "PaymentRecoveryOperation_paymentIntentId_idx" ON "PaymentRecoveryOperation"("paymentIntentId");

-- CreateIndex
CREATE INDEX "PaymentRecoveryOperation_status_nextRetryAt_createdAt_idx" ON "PaymentRecoveryOperation"("status", "nextRetryAt", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentRecoveryOperation_type_status_idx" ON "PaymentRecoveryOperation"("type", "status");

-- AddForeignKey
ALTER TABLE "PaymentRecoveryOperation" ADD CONSTRAINT "PaymentRecoveryOperation_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecoveryOperation" ADD CONSTRAINT "PaymentRecoveryOperation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRecoveryOperation" ADD CONSTRAINT "PaymentRecoveryOperation_paymentTransactionId_fkey" FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill risky rows from the best-effort zero-dollar cleanup window:
-- paid zero-dollar bookings that still have a positive pending/processing primary
-- PaymentIntent transaction.
INSERT INTO "PaymentRecoveryOperation" (
    "id",
    "type",
    "status",
    "bookingId",
    "paymentId",
    "paymentTransactionId",
    "paymentIntentId",
    "amountCents",
    "idempotencyKey",
    "attempts",
    "nextRetryAt",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid()::text,
    'CANCEL_PAYMENT_INTENT'::"PaymentRecoveryOperationType",
    'PENDING'::"PaymentRecoveryOperationStatus",
    b."id",
    p."id",
    pt."id",
    pt."stripePaymentIntentId",
    pt."amountCents",
    'payment_recovery_cancel_' || pt."id" || '_' || pt."stripePaymentIntentId",
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Booking" b
JOIN "Payment" p ON p."bookingId" = b."id"
JOIN "PaymentTransaction" pt ON pt."paymentId" = p."id"
WHERE b."status" = 'PAID'
  AND b."finalPriceCents" = 0
  AND p."status" = 'SUCCEEDED'
  AND p."amountCents" = 0
  AND pt."kind" = 'PRIMARY'
  AND pt."status" IN ('PENDING', 'PROCESSING')
  AND pt."amountCents" > 0
ON CONFLICT ("idempotencyKey") DO NOTHING;
