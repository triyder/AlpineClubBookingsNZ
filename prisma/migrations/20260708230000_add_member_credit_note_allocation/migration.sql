-- #1620: per-note credit-lot allocation ledger for "allocate-existing" applied
-- credit. EXPAND-only: a brand-new table with a foreign key to the existing
-- MemberCredit lot. Nothing the previous colour reads is touched, so this is
-- blue/green safe.

-- CreateTable
CREATE TABLE "MemberCreditNoteAllocation" (
    "id" TEXT NOT NULL,
    "memberCreditId" TEXT NOT NULL,
    "xeroCreditNoteId" TEXT NOT NULL,
    "appliedToBookingId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberCreditNoteAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemberCreditNoteAllocation_lot_booking_key" ON "MemberCreditNoteAllocation"("memberCreditId", "appliedToBookingId");

-- CreateIndex
CREATE INDEX "MemberCreditNoteAllocation_appliedToBookingId_idx" ON "MemberCreditNoteAllocation"("appliedToBookingId");

-- CreateIndex
CREATE INDEX "MemberCreditNoteAllocation_xeroCreditNoteId_idx" ON "MemberCreditNoteAllocation"("xeroCreditNoteId");

-- AddForeignKey
ALTER TABLE "MemberCreditNoteAllocation" ADD CONSTRAINT "MemberCreditNoteAllocation_memberCreditId_fkey" FOREIGN KEY ("memberCreditId") REFERENCES "MemberCredit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
