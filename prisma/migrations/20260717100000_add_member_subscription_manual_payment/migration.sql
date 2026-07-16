-- E14 (#1944): manual mark-paid provenance for MemberSubscription.
--
-- Additive, nullable, expand-only. Existing rows get NULLs and are unaffected;
-- old application versions that neither read nor write these columns keep
-- working during a blue/green deploy. ADD COLUMN with no default is a
-- catalog-only change on PostgreSQL 11+ (no table rewrite, brief lock).
--
-- The FK to Member is ON DELETE SET NULL: deleting the acting admin never
-- cascades into the subscription row, it only forgets who performed the manual
-- action. manualPaymentNote is bounded (VARCHAR(500)) to match the API cap.
ALTER TABLE "MemberSubscription"
  ADD COLUMN "manuallyMarkedPaidAt" TIMESTAMP(3),
  ADD COLUMN "manuallyMarkedPaidByMemberId" TEXT,
  ADD COLUMN "manualPaymentNote" VARCHAR(500);

CREATE INDEX "MemberSubscription_manuallyMarkedPaidByMemberId_idx"
  ON "MemberSubscription"("manuallyMarkedPaidByMemberId");

ALTER TABLE "MemberSubscription"
  ADD CONSTRAINT "MemberSubscription_manuallyMarkedPaidByMemberId_fkey"
  FOREIGN KEY ("manuallyMarkedPaidByMemberId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
