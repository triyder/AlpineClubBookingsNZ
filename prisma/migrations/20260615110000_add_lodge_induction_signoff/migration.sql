-- Lodge Induction Sign-Off: versioned induction checklist, per-member induction
-- records with sign-offs, and the membership nomination eligibility gate.

-- Admin-managed flag to require a member to complete a lodge induction.
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "requiresInduction" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum InductionStatus
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InductionStatus') THEN
    CREATE TYPE "InductionStatus" AS ENUM ('DRAFT', 'IN_PROGRESS', 'COMPLETED', 'VOIDED');
  END IF;
END $$;

-- CreateEnum InductionKind
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InductionKind') THEN
    CREATE TYPE "InductionKind" AS ENUM ('NEW_MEMBER', 'YOUTH_TO_FULL', 'RE_INDUCTION');
  END IF;
END $$;

-- CreateEnum InductionSignerRole
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InductionSignerRole') THEN
    CREATE TYPE "InductionSignerRole" AS ENUM ('NOMINATOR', 'HUT_LEADER', 'ADMIN');
  END IF;
END $$;

-- CreateEnum InductionCompletionSource
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InductionCompletionSource') THEN
    CREATE TYPE "InductionCompletionSource" AS ENUM ('SIGN_OFFS', 'ADMIN_OVERRIDE');
  END IF;
END $$;

-- CreateEnum InductionItemResultValue
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InductionItemResultValue') THEN
    CREATE TYPE "InductionItemResultValue" AS ENUM ('YES', 'NO', 'NOT_APPLICABLE');
  END IF;
END $$;

-- CreateEnum InductionSectionPriority
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'InductionSectionPriority') THEN
    CREATE TYPE "InductionSectionPriority" AS ENUM ('EMERGENCY', 'SECURITY', 'STARTUP', 'SHUTDOWN', 'GENERAL');
  END IF;
END $$;

-- CreateTable InductionChecklistTemplate
CREATE TABLE IF NOT EXISTS "InductionChecklistTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InductionChecklistTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InductionChecklistTemplate_isActive_idx" ON "InductionChecklistTemplate"("isActive");

-- CreateTable InductionChecklistSection
CREATE TABLE IF NOT EXISTS "InductionChecklistSection" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" "InductionSectionPriority" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "InductionChecklistSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InductionChecklistSection_templateId_idx" ON "InductionChecklistSection"("templateId");

-- CreateTable InductionChecklistItem
CREATE TABLE IF NOT EXISTS "InductionChecklistItem" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "competencyPrompt" TEXT,
    "notesPrompt" TEXT,
    "isMandatory" BOOLEAN NOT NULL DEFAULT false,
    "requiresDemonstration" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "legacySourceText" TEXT,

    CONSTRAINT "InductionChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "InductionChecklistItem_sectionId_idx" ON "InductionChecklistItem"("sectionId");

-- CreateTable MemberInduction
CREATE TABLE IF NOT EXISTS "MemberInduction" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "applicationId" TEXT,
    "kind" "InductionKind" NOT NULL DEFAULT 'NEW_MEMBER',
    "status" "InductionStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "requiredSignOffs" INTEGER NOT NULL DEFAULT 2,
    "inductionDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completionSource" "InductionCompletionSource",
    "finalComments" TEXT,
    "voidedReason" TEXT,
    "createdByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemberInduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MemberInduction_applicationId_key" ON "MemberInduction"("applicationId");
CREATE INDEX IF NOT EXISTS "MemberInduction_memberId_idx" ON "MemberInduction"("memberId");
CREATE INDEX IF NOT EXISTS "MemberInduction_templateId_idx" ON "MemberInduction"("templateId");
CREATE INDEX IF NOT EXISTS "MemberInduction_status_idx" ON "MemberInduction"("status");
CREATE INDEX IF NOT EXISTS "MemberInduction_kind_idx" ON "MemberInduction"("kind");

-- CreateTable MemberInductionItemResult
CREATE TABLE IF NOT EXISTS "MemberInductionItemResult" (
    "id" TEXT NOT NULL,
    "inductionId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "result" "InductionItemResultValue" NOT NULL,
    "explanationProvided" BOOLEAN NOT NULL DEFAULT false,
    "demonstrationProvided" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "recordedByMemberId" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "MemberInductionItemResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MemberInductionItemResult_inductionId_itemId_key" ON "MemberInductionItemResult"("inductionId", "itemId");
CREATE INDEX IF NOT EXISTS "MemberInductionItemResult_inductionId_idx" ON "MemberInductionItemResult"("inductionId");
CREATE INDEX IF NOT EXISTS "MemberInductionItemResult_itemId_idx" ON "MemberInductionItemResult"("itemId");

-- CreateTable MemberInductionSignOff
CREATE TABLE IF NOT EXISTS "MemberInductionSignOff" (
    "id" TEXT NOT NULL,
    "inductionId" TEXT NOT NULL,
    "signerMemberId" TEXT,
    "signerName" TEXT NOT NULL,
    "signerRole" "InductionSignerRole" NOT NULL,
    "declarationAccepted" BOOLEAN NOT NULL DEFAULT false,
    "comments" TEXT,
    "signedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberInductionSignOff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "MemberInductionSignOff_inductionId_signerMemberId_key" ON "MemberInductionSignOff"("inductionId", "signerMemberId");
CREATE INDEX IF NOT EXISTS "MemberInductionSignOff_inductionId_idx" ON "MemberInductionSignOff"("inductionId");
CREATE INDEX IF NOT EXISTS "MemberInductionSignOff_signerMemberId_idx" ON "MemberInductionSignOff"("signerMemberId");

-- CreateTable MembershipNominationSettings
CREATE TABLE IF NOT EXISTS "MembershipNominationSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "gateEnabled" BOOLEAN NOT NULL DEFAULT false,
    "minimumMembershipMonths" INTEGER NOT NULL DEFAULT 12,
    "minimumNights" INTEGER NOT NULL DEFAULT 6,
    "requiredSignOffs" INTEGER NOT NULL DEFAULT 2,
    "gateEffectiveFrom" TIMESTAMP(3),
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipNominationSettings_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'InductionChecklistSection_templateId_fkey'
  ) THEN
    ALTER TABLE "InductionChecklistSection" ADD CONSTRAINT "InductionChecklistSection_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "InductionChecklistTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'InductionChecklistItem_sectionId_fkey'
  ) THEN
    ALTER TABLE "InductionChecklistItem" ADD CONSTRAINT "InductionChecklistItem_sectionId_fkey"
      FOREIGN KEY ("sectionId") REFERENCES "InductionChecklistSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberInduction_memberId_fkey'
  ) THEN
    ALTER TABLE "MemberInduction" ADD CONSTRAINT "MemberInduction_memberId_fkey"
      FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberInduction_templateId_fkey'
  ) THEN
    ALTER TABLE "MemberInduction" ADD CONSTRAINT "MemberInduction_templateId_fkey"
      FOREIGN KEY ("templateId") REFERENCES "InductionChecklistTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberInduction_applicationId_fkey'
  ) THEN
    ALTER TABLE "MemberInduction" ADD CONSTRAINT "MemberInduction_applicationId_fkey"
      FOREIGN KEY ("applicationId") REFERENCES "MemberApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberInductionItemResult_inductionId_fkey'
  ) THEN
    ALTER TABLE "MemberInductionItemResult" ADD CONSTRAINT "MemberInductionItemResult_inductionId_fkey"
      FOREIGN KEY ("inductionId") REFERENCES "MemberInduction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberInductionItemResult_itemId_fkey'
  ) THEN
    ALTER TABLE "MemberInductionItemResult" ADD CONSTRAINT "MemberInductionItemResult_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "InductionChecklistItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberInductionSignOff_inductionId_fkey'
  ) THEN
    ALTER TABLE "MemberInductionSignOff" ADD CONSTRAINT "MemberInductionSignOff_inductionId_fkey"
      FOREIGN KEY ("inductionId") REFERENCES "MemberInduction"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'MemberInductionSignOff_signerMemberId_fkey'
  ) THEN
    ALTER TABLE "MemberInductionSignOff" ADD CONSTRAINT "MemberInductionSignOff_signerMemberId_fkey"
      FOREIGN KEY ("signerMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
