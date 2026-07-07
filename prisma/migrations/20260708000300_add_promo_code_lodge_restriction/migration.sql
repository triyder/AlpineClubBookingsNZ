-- Phase 6 expand release (docs/multi-lodge/implementation-plan.md, ADR-001
-- resolved question 4): optional per-lodge promo restriction junction. No
-- rows = redeemable at every lodge; old code ignores the new table.

-- CreateTable
CREATE TABLE "PromoCodeLodge" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "lodgeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoCodeLodge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromoCodeLodge_lodgeId_idx" ON "PromoCodeLodge"("lodgeId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoCodeLodge_promoCodeId_lodgeId_key" ON "PromoCodeLodge"("promoCodeId", "lodgeId");

-- AddForeignKey
ALTER TABLE "PromoCodeLodge" ADD CONSTRAINT "PromoCodeLodge_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoCodeLodge" ADD CONSTRAINT "PromoCodeLodge_lodgeId_fkey" FOREIGN KEY ("lodgeId") REFERENCES "Lodge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

