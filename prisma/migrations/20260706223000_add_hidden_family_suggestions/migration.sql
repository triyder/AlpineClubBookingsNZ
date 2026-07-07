-- Persist admin-hidden family suggestion member sets. The signature is the
-- canonical sorted member-id set and is recomputed server-side before writes.
CREATE TABLE "HiddenFamilySuggestion" (
    "id" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "memberIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "hiddenByMemberId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HiddenFamilySuggestion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HiddenFamilySuggestion_signature_key" ON "HiddenFamilySuggestion"("signature");
CREATE INDEX "HiddenFamilySuggestion_hiddenByMemberId_idx" ON "HiddenFamilySuggestion"("hiddenByMemberId");
CREATE INDEX "HiddenFamilySuggestion_createdAt_idx" ON "HiddenFamilySuggestion"("createdAt");
