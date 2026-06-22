-- Admin on/off toggles for newly modularised features (group bookings, lockers,
-- lodge induction, work parties, promo codes, hut leaders, communications, and
-- ski-field conditions). All default true so existing installs keep these
-- features on; each club disables what it does not use via the admin Modules
-- page. Constant-default ADD COLUMN is metadata-only on PostgreSQL 11+ (brief
-- ACCESS EXCLUSIVE lock on the single-row ClubModuleSettings table, no rewrite).
ALTER TABLE "ClubModuleSettings" ADD COLUMN "groupBookings" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubModuleSettings" ADD COLUMN "lockers" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubModuleSettings" ADD COLUMN "induction" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubModuleSettings" ADD COLUMN "workParties" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubModuleSettings" ADD COLUMN "promoCodes" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubModuleSettings" ADD COLUMN "hutLeaders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubModuleSettings" ADD COLUMN "communications" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "ClubModuleSettings" ADD COLUMN "skifieldConditions" BOOLEAN NOT NULL DEFAULT true;
