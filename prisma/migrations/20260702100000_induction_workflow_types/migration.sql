-- Add the hut-leader induction workflow and member eligibility flag.
ALTER TYPE "InductionKind" ADD VALUE IF NOT EXISTS 'HUT_LEADER';

ALTER TABLE "Member"
  ADD COLUMN IF NOT EXISTS "hutLeaderEligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "hutLeaderEligibleAt" TIMESTAMP(3);

ALTER TABLE "InductionChecklistTemplate"
  ADD COLUMN IF NOT EXISTS "kind" "InductionKind" NOT NULL DEFAULT 'NEW_MEMBER';

WITH ranked_active_templates AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "kind"
      ORDER BY "createdAt" DESC, "id" DESC
    ) AS rn
  FROM "InductionChecklistTemplate"
  WHERE "isActive" = true
)
UPDATE "InductionChecklistTemplate"
SET "isActive" = false
WHERE "id" IN (
  SELECT "id"
  FROM ranked_active_templates
  WHERE rn > 1
);

CREATE INDEX IF NOT EXISTS "Member_hutLeaderEligible_idx"
  ON "Member"("hutLeaderEligible");

CREATE INDEX IF NOT EXISTS "InductionChecklistTemplate_kind_isActive_idx"
  ON "InductionChecklistTemplate"("kind", "isActive");

CREATE UNIQUE INDEX IF NOT EXISTS "InductionChecklistTemplate_kind_active_unique"
  ON "InductionChecklistTemplate"("kind")
  WHERE "isActive" = true;

-- Retire in-flight self-assessment and per-item result state. Completed
-- historical rows stay in place for audit/back-reference, but new code no
-- longer reads or writes these fields.
UPDATE "MemberInduction"
SET "selfAssessedAt" = NULL,
    "selfAssessmentJson" = NULL
WHERE "status" IN ('DRAFT', 'IN_PROGRESS')
  AND ("selfAssessedAt" IS NOT NULL OR "selfAssessmentJson" IS NOT NULL);

DELETE FROM "MemberInductionItemResult"
WHERE "inductionId" IN (
  SELECT "id"
  FROM "MemberInduction"
  WHERE "status" IN ('DRAFT', 'IN_PROGRESS')
);
