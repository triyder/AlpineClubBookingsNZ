-- Reconcile DB-level defaults with schema.prisma.
--
-- `BedAllocationSettings.updatedAt` and `ClubTheme.updatedAt` are declared in
-- schema.prisma as `DateTime @updatedAt` -- application-managed fields with no
-- database default. Their original create-table migrations seeded a default row
-- via INSERTs that omitted `updatedAt`, so the column was given
-- `DEFAULT CURRENT_TIMESTAMP` to satisfy the NOT NULL constraint at seed time.
-- That leaves a DB-level default that drifts from schema.prisma, so
-- `prisma migrate diff` reports a difference (and the deploy migration-safety
-- gate aborts).
--
-- Drop the defaults to bring the database in line with schema.prisma. This is a
-- behavioural no-op: Prisma Client always sets `updatedAt` on every write, and
-- the original seed rows already exist. Editing the original migrations would be
-- wrong -- their seed INSERTs depend on the default and they are already applied
-- in CI/dev (checksum mismatch) -- so this follow-up migration is the correct fix.
ALTER TABLE "BedAllocationSettings" ALTER COLUMN "updatedAt" DROP DEFAULT;
ALTER TABLE "ClubTheme" ALTER COLUMN "updatedAt" DROP DEFAULT;
