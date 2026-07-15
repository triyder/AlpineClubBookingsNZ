-- Phone-number visibility opt-in for lodge screens (#37 / #124). Two additive,
-- nullable-safe ADD COLUMNs with a constant DEFAULT false: a metadata-only
-- catalog change on modern Postgres (no table rewrite, no row scan). No serving
-- change here — enforcement lands in the serialisers (#125).
--
-- Member is booking-path hot; the ADD COLUMN with a constant default takes only
-- a brief ACCESS EXCLUSIVE lock and does not rewrite the table. Old-colour
-- compatible: the previously deployed Prisma client has no field for either
-- column and never reads or writes them (both default false = current behaviour,
-- no phones shown). No backfill.
ALTER TABLE "Member" ADD COLUMN "lodgeScreenPhoneOptIn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Lodge" ADD COLUMN "showGuestPhonesOnScreens" BOOLEAN NOT NULL DEFAULT false;
