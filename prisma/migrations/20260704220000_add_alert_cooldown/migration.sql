-- CreateTable
CREATE TABLE "AlertCooldown" (
    "key" TEXT NOT NULL,
    "lastAlertedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AlertCooldown_pkey" PRIMARY KEY ("key")
);
