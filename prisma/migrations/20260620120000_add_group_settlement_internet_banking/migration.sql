-- Internet Banking for organiser settlement.
-- An ORGANISER_PAYS organiser may now settle the whole group by one combined Xero
-- invoice paid by Internet Banking instead of a Stripe PaymentIntent. Record the
-- chosen source (defaulting to the existing Stripe behaviour) and the raised
-- invoice so inbound Xero reconciliation can flip the joiner children to PAID when
-- the combined invoice is settled. Purely additive nullable columns plus a
-- defaulted enum column: blue/green safe.

-- AlterTable
ALTER TABLE "GroupBookingSettlement" ADD COLUMN     "source" "PaymentSource" NOT NULL DEFAULT 'STRIPE',
ADD COLUMN     "xeroInvoiceId" TEXT,
ADD COLUMN     "xeroInvoiceNumber" TEXT;
