-- Create enum for editable website pages
CREATE TYPE "EditablePageSlug" AS ENUM ('ABOUT', 'JOIN');

-- Create table for admin-managed page HTML content
CREATE TABLE "PageContent" (
    "id" TEXT NOT NULL,
    "slug" "EditablePageSlug" NOT NULL,
    "title" TEXT NOT NULL,
    "contentHtml" TEXT NOT NULL,
    "updatedByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PageContent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PageContent_slug_key" ON "PageContent"("slug");
CREATE INDEX "PageContent_updatedByMemberId_idx" ON "PageContent"("updatedByMemberId");
