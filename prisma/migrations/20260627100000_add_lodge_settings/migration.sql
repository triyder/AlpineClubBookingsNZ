-- Singleton lodge configuration. `capacity` is an admin-set fallback for the
-- lodge's total capacity, used when the Bed Allocation module is not providing
-- an active bed count. Null means fall back to the club config bed total.
CREATE TABLE IF NOT EXISTS "LodgeSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "capacity" INTEGER,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LodgeSettings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "LodgeSettings_updatedByMemberId_idx" ON "LodgeSettings"("updatedByMemberId");

INSERT INTO "LodgeSettings" ("id")
VALUES ('default')
ON CONFLICT ("id") DO NOTHING;
