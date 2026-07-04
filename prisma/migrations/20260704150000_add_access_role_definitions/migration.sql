-- CreateEnum
CREATE TYPE "AdminPermissionLevel" AS ENUM ('NONE', 'VIEW', 'EDIT');

-- CreateTable
CREATE TABLE "AccessRoleDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "systemRole" "AccessRole",
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "overviewLevel" "AdminPermissionLevel" NOT NULL DEFAULT 'NONE',
    "bookingsLevel" "AdminPermissionLevel" NOT NULL DEFAULT 'NONE',
    "membershipLevel" "AdminPermissionLevel" NOT NULL DEFAULT 'NONE',
    "financeLevel" "AdminPermissionLevel" NOT NULL DEFAULT 'NONE',
    "lodgeLevel" "AdminPermissionLevel" NOT NULL DEFAULT 'NONE',
    "contentLevel" "AdminPermissionLevel" NOT NULL DEFAULT 'NONE',
    "supportLevel" "AdminPermissionLevel" NOT NULL DEFAULT 'NONE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRoleDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessRoleDefinition_key_key" ON "AccessRoleDefinition"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRoleDefinition_systemRole_key" ON "AccessRoleDefinition"("systemRole");

-- CreateIndex
CREATE INDEX "AccessRoleDefinition_sortOrder_idx" ON "AccessRoleDefinition"("sortOrder");

-- AlterTable: assignments may now be backed by a definition instead of an
-- enum value. Existing rows keep their enum value; custom-role rows use NULL.
ALTER TABLE "MemberAccessRole" ALTER COLUMN "role" DROP NOT NULL;
ALTER TABLE "MemberAccessRole" ADD COLUMN "roleDefinitionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MemberAccessRole_memberId_roleDefinitionId_key" ON "MemberAccessRole"("memberId", "roleDefinitionId");

-- CreateIndex
CREATE INDEX "MemberAccessRole_roleDefinitionId_idx" ON "MemberAccessRole"("roleDefinitionId");

-- AddForeignKey
ALTER TABLE "MemberAccessRole" ADD CONSTRAINT "MemberAccessRole_roleDefinitionId_fkey" FOREIGN KEY ("roleDefinitionId") REFERENCES "AccessRoleDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed the six editable default role definitions with matrices identical to
-- the legacy hardcoded ADMIN_ROLE_BUNDLES so behavior is unchanged at cutover.
-- updatedAt is supplied explicitly (no column DEFAULT) to match Prisma's
-- @updatedAt convention and keep the migrate-diff drift gate clean.
INSERT INTO "AccessRoleDefinition" (
    "id", "key", "systemRole", "label", "description",
    "overviewLevel", "bookingsLevel", "membershipLevel", "financeLevel",
    "lodgeLevel", "contentLevel", "supportLevel",
    "sortOrder", "createdAt", "updatedAt"
) VALUES
    ('ardef_admin_readonly', 'read-only-admin', 'ADMIN_READONLY', 'Read-only Admin',
     'Can view admin areas without making changes.',
     'VIEW', 'VIEW', 'VIEW', 'VIEW', 'VIEW', 'VIEW', 'VIEW',
     10, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ardef_admin_bookings', 'booking-officer', 'ADMIN_BOOKINGS', 'Booking Officer',
     'Can manage bookings, bed allocation, and lodge operations.',
     'VIEW', 'EDIT', 'VIEW', 'VIEW', 'EDIT', 'NONE', 'VIEW',
     20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ardef_admin_membership', 'membership-officer', 'ADMIN_MEMBERSHIP', 'Membership Officer',
     'Can manage members, applications, and membership setup.',
     'VIEW', 'VIEW', 'EDIT', 'VIEW', 'NONE', 'NONE', 'VIEW',
     30, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ardef_admin_content', 'content-manager', 'ADMIN_CONTENT', 'Content Manager',
     'Can manage public website content, banners, and images.',
     'VIEW', 'NONE', 'NONE', 'NONE', 'NONE', 'EDIT', 'NONE',
     40, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ardef_finance_user', 'finance-viewer', 'FINANCE_USER', 'Finance Viewer',
     'Can view finance dashboard data.',
     'NONE', 'NONE', 'NONE', 'VIEW', 'NONE', 'NONE', 'NONE',
     50, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('ardef_finance_admin', 'treasurer', 'FINANCE_ADMIN', 'Treasurer',
     'Can manage finance, payments, subscriptions, and Xero.',
     'VIEW', 'VIEW', 'VIEW', 'EDIT', 'NONE', 'NONE', 'VIEW',
     60, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- Backfill: link existing enum-valued assignment rows to their seeded
-- definitions. Idempotent; rows written by old code during the deploy window
-- are re-linked by ensureAccessRoleDefinitions() on the next seed run.
UPDATE "MemberAccessRole" m
SET "roleDefinitionId" = d."id"
FROM "AccessRoleDefinition" d
WHERE m."role" = d."systemRole"
  AND m."roleDefinitionId" IS NULL;
