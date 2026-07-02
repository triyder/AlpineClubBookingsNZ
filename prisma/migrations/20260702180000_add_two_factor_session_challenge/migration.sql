-- CreateTable
CREATE TABLE "TwoFactorSessionChallenge" (
  "id" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TwoFactorSessionChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwoFactorSessionChallenge_tokenHash_key" ON "TwoFactorSessionChallenge"("tokenHash");
CREATE INDEX "TwoFactorSessionChallenge_memberId_idx" ON "TwoFactorSessionChallenge"("memberId");
CREATE INDEX "TwoFactorSessionChallenge_expiresAt_idx" ON "TwoFactorSessionChallenge"("expiresAt");

-- AddForeignKey
ALTER TABLE "TwoFactorSessionChallenge"
  ADD CONSTRAINT "TwoFactorSessionChallenge_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
