-- Group bookings (shareable join code).
-- An organiser opens one of their bookings as a private group event and shares a
-- short join code. Members and non-members add themselves via /join/[code]; each
-- joiner becomes their own child Booking linked to the organiser booking through
-- Booking.parentBookingId (the existing split-booking relation). GroupBookingJoin
-- stages the non-member email-verify handshake (contact + guest snapshot + token
-- hash) before any child booking exists, and doubles as the admin-visible roster.
-- Purely additive (new enums, tables, nullable relations): blue/green safe.

-- CreateEnum
CREATE TYPE "GroupBookingPaymentMode" AS ENUM ('EACH_PAYS_OWN', 'ORGANISER_PAYS');

-- CreateEnum
CREATE TYPE "GroupBookingStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "GroupBooking" (
    "id" TEXT NOT NULL,
    "organiserBookingId" TEXT NOT NULL,
    "organiserMemberId" TEXT NOT NULL,
    "joinCode" TEXT NOT NULL,
    "paymentMode" "GroupBookingPaymentMode" NOT NULL,
    "status" "GroupBookingStatus" NOT NULL DEFAULT 'OPEN',
    "joinDeadline" TIMESTAMP(3),
    "maxJoiners" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupBookingJoin" (
    "id" TEXT NOT NULL,
    "groupBookingId" TEXT NOT NULL,
    "bookingId" TEXT,
    "joinerMemberId" TEXT,
    "isMember" BOOLEAN NOT NULL DEFAULT false,
    "contactFirstName" VARCHAR(100),
    "contactLastName" VARCHAR(100),
    "contactEmail" VARCHAR(200),
    "contactPhone" VARCHAR(30),
    "guestsSnapshot" JSONB,
    "verificationTokenHash" TEXT,
    "verificationTokenExpiresAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupBookingJoin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupBooking_organiserBookingId_key" ON "GroupBooking"("organiserBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBooking_joinCode_key" ON "GroupBooking"("joinCode");

-- CreateIndex
CREATE INDEX "GroupBooking_organiserMemberId_idx" ON "GroupBooking"("organiserMemberId");

-- CreateIndex
CREATE INDEX "GroupBooking_status_joinDeadline_idx" ON "GroupBooking"("status", "joinDeadline");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBookingJoin_bookingId_key" ON "GroupBookingJoin"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupBookingJoin_verificationTokenHash_key" ON "GroupBookingJoin"("verificationTokenHash");

-- CreateIndex
CREATE INDEX "GroupBookingJoin_groupBookingId_idx" ON "GroupBookingJoin"("groupBookingId");

-- CreateIndex
CREATE INDEX "GroupBookingJoin_verificationTokenExpiresAt_idx" ON "GroupBookingJoin"("verificationTokenExpiresAt");

-- CreateIndex
CREATE INDEX "GroupBookingJoin_contactEmail_idx" ON "GroupBookingJoin"("contactEmail");

-- AddForeignKey
ALTER TABLE "GroupBooking" ADD CONSTRAINT "GroupBooking_organiserBookingId_fkey" FOREIGN KEY ("organiserBookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBooking" ADD CONSTRAINT "GroupBooking_organiserMemberId_fkey" FOREIGN KEY ("organiserMemberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBookingJoin" ADD CONSTRAINT "GroupBookingJoin_groupBookingId_fkey" FOREIGN KEY ("groupBookingId") REFERENCES "GroupBooking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBookingJoin" ADD CONSTRAINT "GroupBookingJoin_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupBookingJoin" ADD CONSTRAINT "GroupBookingJoin_joinerMemberId_fkey" FOREIGN KEY ("joinerMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
