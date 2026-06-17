-- Induction: assigned signers + member self-assessment
-- Adds an explicit signer assignment table so admins can designate who must
-- sign off a re-induction (where there is no membership application/nominator).
-- Also adds a self-assessment JSON blob so the inductee can tick off each
-- checklist item before their signers formally sign off.

-- Self-assessment columns on MemberInduction
ALTER TABLE "MemberInduction" ADD COLUMN IF NOT EXISTS "selfAssessedAt"     TIMESTAMP(3);
ALTER TABLE "MemberInduction" ADD COLUMN IF NOT EXISTS "selfAssessmentJson"  TEXT;

-- Assigned signers table
CREATE TABLE IF NOT EXISTS "MemberInductionAssignedSigner" (
  "id"          TEXT        NOT NULL,
  "inductionId" TEXT        NOT NULL,
  "memberId"    TEXT        NOT NULL,
  "emailSentAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MemberInductionAssignedSigner_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MemberInductionAssignedSigner_inductionId_memberId_key"
  ON "MemberInductionAssignedSigner"("inductionId", "memberId");

CREATE INDEX IF NOT EXISTS "MemberInductionAssignedSigner_inductionId_idx"
  ON "MemberInductionAssignedSigner"("inductionId");

CREATE INDEX IF NOT EXISTS "MemberInductionAssignedSigner_memberId_idx"
  ON "MemberInductionAssignedSigner"("memberId");

ALTER TABLE "MemberInductionAssignedSigner"
  ADD CONSTRAINT "MemberInductionAssignedSigner_inductionId_fkey"
  FOREIGN KEY ("inductionId") REFERENCES "MemberInduction"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemberInductionAssignedSigner"
  ADD CONSTRAINT "MemberInductionAssignedSigner_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
