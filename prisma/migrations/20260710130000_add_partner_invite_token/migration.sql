-- CreateTable
CREATE TABLE "PartnerInviteToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyGroupId" TEXT NOT NULL,
    "invitedEmail" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PartnerInviteToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PartnerInviteToken_tokenHash_key" ON "PartnerInviteToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PartnerInviteToken_familyGroupId_idx" ON "PartnerInviteToken"("familyGroupId");

-- CreateIndex
CREATE INDEX "PartnerInviteToken_createdById_idx" ON "PartnerInviteToken"("createdById");

-- CreateIndex
CREATE INDEX "PartnerInviteToken_expiresAt_idx" ON "PartnerInviteToken"("expiresAt");

-- CreateIndex
CREATE INDEX "PartnerInviteToken_invitedEmail_idx" ON "PartnerInviteToken"("invitedEmail");

-- AddForeignKey
ALTER TABLE "PartnerInviteToken" ADD CONSTRAINT "PartnerInviteToken_familyGroupId_fkey" FOREIGN KEY ("familyGroupId") REFERENCES "FamilyGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartnerInviteToken" ADD CONSTRAINT "PartnerInviteToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
