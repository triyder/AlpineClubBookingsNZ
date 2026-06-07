DROP INDEX IF EXISTS "MemberCredit_sourceBookingModificationId_idx";

CREATE UNIQUE INDEX "MemberCredit_sourceBookingModificationId_key"
  ON "MemberCredit"("sourceBookingModificationId");
