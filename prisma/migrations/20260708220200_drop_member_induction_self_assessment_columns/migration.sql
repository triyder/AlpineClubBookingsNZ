-- Contract release: drop the retired MemberInduction self-assessment columns.
-- The 20260702100000_induction_workflow_types runtime NULLed all in-flight rows
-- and moved every read/write off these fields; nothing has read or written them
-- since. Production held zero non-NULL values across all 4 rows (verified 2026-07-08).
ALTER TABLE "MemberInduction" DROP COLUMN "selfAssessedAt";
ALTER TABLE "MemberInduction" DROP COLUMN "selfAssessmentJson";
