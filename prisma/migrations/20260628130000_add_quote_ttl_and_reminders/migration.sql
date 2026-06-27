-- AlterTable
ALTER TABLE "BookingRequestQuote" ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "BookingRequestSettings" ADD COLUMN     "quoteReminderLeadDays" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "quoteResponseTtlDays" INTEGER NOT NULL DEFAULT 14;
