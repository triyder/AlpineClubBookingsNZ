-- The single-Pass induction flow no longer records per-item results. The
-- MemberInductionItemResult table and its InductionItemResultValue enum were
-- retired at the code level by 20260702100000_induction_workflow_types; no
-- deployed runtime has read or written this table since, and production holds
-- zero rows (verified 2026-07-08, evidence on #1532), so this contract-phase
-- drop loses no data.
--
-- Deploy ordering: the code that stopped using the table already shipped. Drop
-- the leaf table first (its FKs point out; nothing references it), then the
-- now-unused enum. No CASCADE, so an unexpected dependency fails loud.
DROP TABLE IF EXISTS "MemberInductionItemResult";
DROP TYPE IF EXISTS "InductionItemResultValue";
