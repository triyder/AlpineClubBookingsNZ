-- Group booking ORGANISER_PAYS settlement.
-- Holds the single combined Stripe PaymentIntent by which the organiser settles
-- every organiser-settled child booking in the group as one bill. At settle time
-- the children are committed to CONFIRMED (capacity held, like a pay-on-account
-- invoice, issue #709); this row flips them all to PAID exactly once on webhook
-- success. Purely additive (one new nullable-relation table): blue/green safe.

-- CreateTable
CREATE TABLE "GroupBookingSettlement" (
    "id" TEXT NOT NULL,
    "groupBookingId" TEXT NOT NULL,
    "stripePaymentIntentId" TEXT,
    "stripeCustomerId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupBookingSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupBookingSettlement_groupBookingId_key" ON "GroupBookingSettlement"("groupBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBookingSettlement_stripePaymentIntentId_key" ON "GroupBookingSettlement"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "GroupBookingSettlement_status_createdAt_idx" ON "GroupBookingSettlement"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "GroupBookingSettlement" ADD CONSTRAINT "GroupBookingSettlement_groupBookingId_fkey" FOREIGN KEY ("groupBookingId") REFERENCES "GroupBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
