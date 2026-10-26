BEGIN;

-- #3954 review round 7 (INV-PAY-120): stamp on an ADDITIONAL request row the
-- edit's own answer to "had the booking's primary Xero invoice been issued?"
-- (`hasIssuedPrimaryXeroInvoice`) at the moment that edit asked for the money.
--
-- A later price reduction that cancels or shrinks the unpaid request splits
-- what it released between a supplementary invoice and an invoice-correction
-- note on the primary invoice. Which one billed the request's own money is
-- exactly that answer: true, its own supplementary invoice bills it; false,
-- the primary invoice raised afterwards bills it. It used to be guessed from
-- when the row was written against when the primary invoice was linked, which
-- a recovery minted hours later, or a backfilled link, gets wrong.
-- PaymentRecoveryOperation.hadIssuedXeroInvoice (#3181) already freezes the
-- same answer for a failed mint's retry; this is its twin for the request row.
--
-- EXPAND ONLY, nullable columns, no DML, no default: NULL means "not
-- recorded", which is the truth for every stored row. A reader that meets NULL
-- falls back to the minting recovery's own answer, and failing that reports the
-- offset for a person rather than guessing. A draining old colour omits both
-- columns on INSERT and never reads them; its rows are NULL, read the same way.
--
-- LOCK IMPACT: each ADD COLUMN with no default is catalog-only on PostgreSQL
-- (no table rewrite), taking ACCESS EXCLUSIVE on "PaymentTransaction" for the
-- catalog changes alone, inside this one short DDL-only transaction. No index,
-- constraint, trigger or foreign key is added.
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "hadIssuedXeroInvoice" BOOLEAN;

-- #3954 review round 8 (INV-PAY-120): and the edit whose ask the row is - the
-- increase that asked, or the reduction whose smaller re-issue it is. A later
-- reduction that retires a door-minted row names that edit in its own history
-- (`retiredAskModificationIds`), so the booking-vs-Xero repair pass reads the
-- increase's invoice as accounted for by the reduction, rather than queueing
-- it again with its payment recorded. Same shape as the column above:
-- nullable, no default, no DML, no index and no foreign key (a provenance
-- stamp read beside the booking's own edits). NULL means not recorded; a
-- reader that meets it names only the edits it can otherwise establish (a
-- parked invoice's anchor, a waiting recovery's edit), as before.
ALTER TABLE "PaymentTransaction"
  ADD COLUMN "bookingModificationId" TEXT;

COMMIT;
