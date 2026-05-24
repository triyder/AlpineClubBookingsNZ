-- AlterEnum
ALTER TYPE "MembershipCancellationParticipantStatus" ADD VALUE 'PENDING_CONFIRMATION';
ALTER TYPE "MembershipCancellationParticipantStatus" ADD VALUE 'DECLINED';

-- AlterTable
ALTER TABLE "MembershipCancellationRequestParticipant"
ADD COLUMN "confirmationTokenHash" TEXT,
ADD COLUMN "confirmationTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "confirmedAt" TIMESTAMP(3),
ADD COLUMN "declinedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "MembershipCancellationRequestParticipant_confirmationTokenHash_key" ON "MembershipCancellationRequestParticipant"("confirmationTokenHash");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequestParticipant_confirmationTokenHash_idx" ON "MembershipCancellationRequestParticipant"("confirmationTokenHash");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequestParticipant_confirmationTokenExpiresAt_idx" ON "MembershipCancellationRequestParticipant"("confirmationTokenExpiresAt");
