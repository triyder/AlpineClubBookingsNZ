-- Public booking request quote workflow.
-- Adds versioned quote records, school catering preference, public response
-- state, and an optional held booking relation. New columns are nullable so
-- existing booking requests and blue/green overlap remain compatible.

-- AlterEnum
ALTER TYPE "BookingRequestStatus" ADD VALUE IF NOT EXISTS 'QUOTED';
ALTER TYPE "BookingRequestStatus" ADD VALUE IF NOT EXISTS 'QUOTE_SENT';
ALTER TYPE "BookingRequestStatus" ADD VALUE IF NOT EXISTS 'QUERY_PENDING';
ALTER TYPE "BookingRequestStatus" ADD VALUE IF NOT EXISTS 'MODIFICATION_REQUESTED';
ALTER TYPE "BookingRequestStatus" ADD VALUE IF NOT EXISTS 'ACCEPTED';
ALTER TYPE "BookingRequestStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- CreateEnum
CREATE TYPE "BookingRequestPricingMode" AS ENUM ('OVERALL_TOTAL', 'PER_GUEST_NIGHT');

-- CreateEnum
CREATE TYPE "BookingRequestQuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SchoolCateringPreference" AS ENUM ('CATERED', 'NON_CATERED', 'QUOTE_BOTH');

-- CreateEnum
CREATE TYPE "SchoolCateringOption" AS ENUM ('CATERED', 'NON_CATERED');

-- AlterTable
ALTER TABLE "BookingRequest" ADD COLUMN "cateringPreference" "SchoolCateringPreference";
ALTER TABLE "BookingRequest" ADD COLUMN "linkedGuestMembers" JSONB;
ALTER TABLE "BookingRequest" ADD COLUMN "heldBookingId" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN "acceptedQuoteId" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN "acceptedQuoteOptionId" TEXT;
ALTER TABLE "BookingRequest" ADD COLUMN "acceptedQuoteSnapshot" JSONB;
ALTER TABLE "BookingRequest" ADD COLUMN "acceptedPriceCents" INTEGER;
ALTER TABLE "BookingRequest" ADD COLUMN "acceptedAt" TIMESTAMP(3);
ALTER TABLE "BookingRequest" ADD COLUMN "responseMessage" VARCHAR(2000);
ALTER TABLE "BookingRequest" ADD COLUMN "responseMessageAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BookingRequestQuote" (
    "id" TEXT NOT NULL,
    "bookingRequestId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BookingRequestQuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "pricingMode" "BookingRequestPricingMode" NOT NULL,
    "options" JSONB NOT NULL,
    "message" VARCHAR(2000),
    "responseTokenHash" TEXT,
    "responseTokenExpiresAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "supersededAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdByMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingRequestQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_heldBookingId_key" ON "BookingRequest"("heldBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequest_acceptedQuoteId_key" ON "BookingRequest"("acceptedQuoteId");

-- CreateIndex
CREATE INDEX "BookingRequest_heldBookingId_idx" ON "BookingRequest"("heldBookingId");

-- CreateIndex
CREATE INDEX "BookingRequest_acceptedQuoteId_idx" ON "BookingRequest"("acceptedQuoteId");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequestQuote_responseTokenHash_key" ON "BookingRequestQuote"("responseTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "BookingRequestQuote_bookingRequestId_version_key" ON "BookingRequestQuote"("bookingRequestId", "version");

-- CreateIndex
CREATE INDEX "BookingRequestQuote_bookingRequestId_status_idx" ON "BookingRequestQuote"("bookingRequestId", "status");

-- CreateIndex
CREATE INDEX "BookingRequestQuote_responseTokenExpiresAt_idx" ON "BookingRequestQuote"("responseTokenExpiresAt");

-- CreateIndex
CREATE INDEX "BookingRequestQuote_createdByMemberId_idx" ON "BookingRequestQuote"("createdByMemberId");

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_heldBookingId_fkey" FOREIGN KEY ("heldBookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequest" ADD CONSTRAINT "BookingRequest_acceptedQuoteId_fkey" FOREIGN KEY ("acceptedQuoteId") REFERENCES "BookingRequestQuote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingRequestQuote" ADD CONSTRAINT "BookingRequestQuote_bookingRequestId_fkey" FOREIGN KEY ("bookingRequestId") REFERENCES "BookingRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
