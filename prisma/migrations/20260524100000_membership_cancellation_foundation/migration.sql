-- CreateEnum
CREATE TYPE "MembershipCancellationRequestStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "MembershipCancellationParticipantStatus" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'REJOINED');

-- AlterTable
ALTER TABLE "Member"
ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelledReason" TEXT,
ADD COLUMN "cancelledViaRequestId" TEXT;

-- CreateTable
CREATE TABLE "MembershipCancellationRequest" (
    "id" TEXT NOT NULL,
    "requestedByMemberId" TEXT,
    "status" "MembershipCancellationRequestStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "adminNote" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByMemberId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipCancellationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipCancellationRequestParticipant" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "MembershipCancellationParticipantStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "adminNote" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "reviewedByMemberId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipCancellationRequestParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipCancellationSetting" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "warningText" TEXT,
    "rejoinProcessText" TEXT,
    "xeroArchiveContactsOnCancellation" BOOLEAN NOT NULL DEFAULT false,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipCancellationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MembershipCancellationXeroContactGroup" (
    "id" TEXT NOT NULL,
    "settingId" TEXT NOT NULL DEFAULT 'default',
    "groupId" TEXT NOT NULL,
    "groupName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipCancellationXeroContactGroup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Member_cancelledViaRequestId_idx" ON "Member"("cancelledViaRequestId");

-- CreateIndex
CREATE INDEX "Member_cancelledAt_idx" ON "Member"("cancelledAt");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequest_requestedByMemberId_idx" ON "MembershipCancellationRequest"("requestedByMemberId");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequest_reviewedByMemberId_idx" ON "MembershipCancellationRequest"("reviewedByMemberId");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequest_status_createdAt_idx" ON "MembershipCancellationRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequest_submittedAt_idx" ON "MembershipCancellationRequest"("submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipCancellationRequestParticipant_requestId_memberId_key" ON "MembershipCancellationRequestParticipant"("requestId", "memberId");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequestParticipant_requestId_status_idx" ON "MembershipCancellationRequestParticipant"("requestId", "status");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequestParticipant_memberId_status_idx" ON "MembershipCancellationRequestParticipant"("memberId", "status");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequestParticipant_reviewedByMemberId_idx" ON "MembershipCancellationRequestParticipant"("reviewedByMemberId");

-- CreateIndex
CREATE INDEX "MembershipCancellationRequestParticipant_cancelledAt_idx" ON "MembershipCancellationRequestParticipant"("cancelledAt");

-- CreateIndex
CREATE INDEX "MembershipCancellationSetting_updatedByMemberId_idx" ON "MembershipCancellationSetting"("updatedByMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "MembershipCancellationXeroContactGroup_settingId_groupId_key" ON "MembershipCancellationXeroContactGroup"("settingId", "groupId");

-- CreateIndex
CREATE INDEX "MembershipCancellationXeroContactGroup_settingId_idx" ON "MembershipCancellationXeroContactGroup"("settingId");

-- CreateIndex
CREATE INDEX "MembershipCancellationXeroContactGroup_groupId_idx" ON "MembershipCancellationXeroContactGroup"("groupId");

-- AddForeignKey
ALTER TABLE "MembershipCancellationRequest" ADD CONSTRAINT "MembershipCancellationRequest_requestedByMemberId_fkey" FOREIGN KEY ("requestedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCancellationRequest" ADD CONSTRAINT "MembershipCancellationRequest_reviewedByMemberId_fkey" FOREIGN KEY ("reviewedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCancellationRequestParticipant" ADD CONSTRAINT "MembershipCancellationRequestParticipant_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "MembershipCancellationRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCancellationRequestParticipant" ADD CONSTRAINT "MembershipCancellationRequestParticipant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCancellationRequestParticipant" ADD CONSTRAINT "MembershipCancellationRequestParticipant_reviewedByMemberId_fkey" FOREIGN KEY ("reviewedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_cancelledViaRequestId_fkey" FOREIGN KEY ("cancelledViaRequestId") REFERENCES "MembershipCancellationRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MembershipCancellationXeroContactGroup" ADD CONSTRAINT "MembershipCancellationXeroContactGroup_settingId_fkey" FOREIGN KEY ("settingId") REFERENCES "MembershipCancellationSetting"("id") ON DELETE CASCADE ON UPDATE CASCADE;
