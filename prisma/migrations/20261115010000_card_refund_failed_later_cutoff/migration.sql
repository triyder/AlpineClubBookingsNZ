-- #4104: a marker, not a schema change. When this migration finished on an
-- install is the cutoff for re-sending a card refund Stripe failed later
-- (`CARD_REFUND_FAILED_LATER_CUTOFF_MIGRATION` in src/lib/card-refund-failed-later.ts):
-- a refund Stripe created before it is raised dead for the treasurer, never re-sent,
-- since it failed while nothing here could notice and may have been paid back by hand.
-- Readable by the previous release: it changes nothing it reads.
SELECT 1;
