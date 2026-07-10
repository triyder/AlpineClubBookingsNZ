-- MemberPartnerLink (#1742): declared Partner/Husband/Wife relationship
-- between two ADULT members. Pure expand: new table + one default-false
-- column on PartnerInviteToken; old code ignores both.

-- CreateTable
CREATE TABLE "MemberPartnerLink" (
    "id" TEXT NOT NULL,
    "memberAId" TEXT NOT NULL,
    "memberBId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "initiatedByMemberId" TEXT,
    "confirmedByMemberId" TEXT,
    "assignedByAdminId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberPartnerLink_pkey" PRIMARY KEY ("id")
);

-- Canonical unordered pair: rows must store the lower member id in memberAId.
-- Strict inequality also makes self-partnering unrepresentable. COLLATE "C"
-- pins the comparison to byte order so it matches the application's
-- code-unit comparison (canonicalPartnerPair) even for non-cuid member ids,
-- where the database's linguistic collation could order a pair differently.
ALTER TABLE "MemberPartnerLink"
    ADD CONSTRAINT "MemberPartnerLink_pair_ordered_check"
    CHECK ("memberAId" < "memberBId" COLLATE "C");

-- CreateIndex
CREATE UNIQUE INDEX "MemberPartnerLink_memberAId_memberBId_key" ON "MemberPartnerLink"("memberAId", "memberBId");

-- CreateIndex
CREATE INDEX "MemberPartnerLink_memberBId_idx" ON "MemberPartnerLink"("memberBId");

-- CreateIndex
CREATE INDEX "MemberPartnerLink_status_idx" ON "MemberPartnerLink"("status");

-- CreateIndex
CREATE INDEX "MemberPartnerLink_initiatedByMemberId_idx" ON "MemberPartnerLink"("initiatedByMemberId");

-- CreateIndex
CREATE INDEX "MemberPartnerLink_confirmedByMemberId_idx" ON "MemberPartnerLink"("confirmedByMemberId");

-- CreateIndex
CREATE INDEX "MemberPartnerLink_assignedByAdminId_idx" ON "MemberPartnerLink"("assignedByAdminId");

-- Partial unique backstops for the one-CONFIRMED-partner-per-member
-- invariant (documented in prisma/partial-unique-indexes.tsv; Prisma cannot
-- express partial indexes). Each column is guarded separately; the
-- cross-column case (one member as A in one link and B in another) is closed
-- by the service layer under pg_advisory_xact_lock on both member ids.
CREATE UNIQUE INDEX "MemberPartnerLink_memberA_confirmed_unique"
    ON "MemberPartnerLink"("memberAId") WHERE "status" = 'CONFIRMED';
CREATE UNIQUE INDEX "MemberPartnerLink_memberB_confirmed_unique"
    ON "MemberPartnerLink"("memberBId") WHERE "status" = 'CONFIRMED';

-- AddForeignKey
ALTER TABLE "MemberPartnerLink" ADD CONSTRAINT "MemberPartnerLink_memberAId_fkey" FOREIGN KEY ("memberAId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPartnerLink" ADD CONSTRAINT "MemberPartnerLink_memberBId_fkey" FOREIGN KEY ("memberBId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPartnerLink" ADD CONSTRAINT "MemberPartnerLink_initiatedByMemberId_fkey" FOREIGN KEY ("initiatedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPartnerLink" ADD CONSTRAINT "MemberPartnerLink_confirmedByMemberId_fkey" FOREIGN KEY ("confirmedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberPartnerLink" ADD CONSTRAINT "MemberPartnerLink_assignedByAdminId_fkey" FOREIGN KEY ("assignedByAdminId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable (#1742 opt-in: claiming a partner-invite token also forms the link)
ALTER TABLE "PartnerInviteToken" ADD COLUMN "createPartnerLink" BOOLEAN NOT NULL DEFAULT false;
