import "server-only";

import type { auth } from "@/lib/auth";
import { getAgeTierSettings } from "@/lib/age-tier";
import { readBookingAmountOwed } from "@/lib/booking-amount-owed";
import {
  bookingInvoiceFileName,
  buildBookingInvoiceData,
} from "@/lib/booking-invoice";
import { canDownloadBookingInvoice } from "@/lib/booking-invoice-access";
import { renderBookingInvoicePdf } from "@/lib/booking-invoice-pdf";
import { bookingOwner } from "@/lib/booking-owner";
import { recordedChangeFeeCents } from "@/lib/booking-payment-state";
import { getClubFormat } from "@/lib/club-format-settings";
import { loadClubTaxSettings } from "@/lib/club-tax-settings";
import { clubTime } from "@/lib/club-time/server";
import { getNetCollectedCashParts } from "@/lib/payment-net-collected";
import { prisma } from "@/lib/prisma";
import { loadRateMembershipLabelResolver } from "@/lib/rate-membership-label";
import { getAuthenticatedXeroClient } from "@/lib/xero-api-client";
import { resolveBookingDetailViewer } from "./booking-detail-viewer";
import { loadBookingDetail } from "./load-booking-detail";

type BookingInvoiceSession = NonNullable<Awaited<ReturnType<typeof auth>>>;

/**
 * The booking invoice download (fork #115), behind `GET
 * /api/bookings/[id]/invoice`.
 *
 * - Access is the booking page's own viewer answer through
 *   `canDownloadBookingInvoice`; anything else is "not found", so the answer
 *   does not reveal that the booking exists.
 * - A booking with a Xero invoice gets Xero's PDF of it (owner decision 3). If
 *   Xero cannot be reached the download fails: it never falls back to a
 *   generated invoice, which would be a second document for the same debt
 *   without the number bank payments are matched on.
 * - Otherwise the invoice is generated from the booking (owner decision 4).
 *
 * Read-only: no database write, and the one provider call runs outside any
 * transaction.
 */
export type BookingInvoiceDownload =
  | { kind: "PDF"; body: Buffer; fileName: string; source: "XERO" | "GENERATED" }
  | { kind: "NOT_FOUND" }
  | { kind: "XERO_UNAVAILABLE" }
  | { kind: "CANNOT_GENERATE"; message: string };

const defaultDependencies = {
  fetchXeroInvoicePdf: async (invoiceId: string): Promise<Buffer> => {
    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const result = await xero.accountingApi.getInvoiceAsPdf(tenantId, invoiceId);
    return Buffer.from(result.body);
  },
};

export async function prepareBookingInvoiceDownload(
  bookingId: string,
  session: BookingInvoiceSession,
  dependencies = defaultDependencies,
): Promise<BookingInvoiceDownload> {
  const booking = await loadBookingDetail(bookingId);
  if (!booking) return { kind: "NOT_FOUND" };
  const viewer = resolveBookingDetailViewer({ session, booking });
  if ((booking.deletedAt && !viewer.isAdmin) || !canDownloadBookingInvoice(viewer)) {
    return { kind: "NOT_FOUND" };
  }

  const xeroInvoiceId = booking.payment?.xeroInvoiceId ?? null;
  if (xeroInvoiceId) {
    try {
      const body = await dependencies.fetchXeroInvoicePdf(xeroInvoiceId);
      if (body.length === 0) return { kind: "XERO_UNAVAILABLE" };
      return {
        kind: "PDF",
        body,
        fileName: bookingInvoiceFileName(booking.id, booking.payment?.xeroInvoiceNumber),
        source: "XERO",
      };
    } catch {
      return { kind: "XERO_UNAVAILABLE" };
    }
  }

  const [lodge, format, club, taxSettings, ageTierSettings, rateResolver, amountOwed] =
    await Promise.all([
      prisma.lodge.findUnique({
        where: { id: booking.lodgeId },
        select: {
          name: true,
          address: true,
          postalAddress: true,
          bankAccountName: true,
          bankAccountDetails: true,
          gstNumber: true,
        },
      }),
      getClubFormat(),
      clubTime(),
      loadClubTaxSettings(prisma),
      getAgeTierSettings(),
      loadRateMembershipLabelResolver(prisma),
      readBookingAmountOwed(booking),
    ]);
  if (!lodge) return { kind: "NOT_FOUND" };

  // Paid so far: the cash this booking took and still holds — the same
  // Net Collected figure the booking page reads (`getNetCollectedCashParts`) —
  // plus any account credit applied to it.
  const heldCashCents = booking.payment
    ? getNetCollectedCashParts({ ...booking.payment, booking }).heldCashCents
    : 0;
  const owner = bookingOwner(booking).member;

  try {
    const data = buildBookingInvoiceData({
      bookingId: booking.id,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      finalPriceCents: booking.finalPriceCents,
      changeFeeCents: recordedChangeFeeCents(booking.payment),
      guests: booking.guests,
      promoRedemptions: booking.promoRedemptions,
      billToName:
        booking.organisation?.name ??
        `${owner?.firstName ?? ""} ${owner?.lastName ?? ""}`.trim(),
      lodge,
      gstRegistered: taxSettings.gstRegistered,
      amountPaidCents: heldCashCents + amountOwed.appliedCreditCents,
      today: club.today(),
      format,
      ageTierLabels: new Map(ageTierSettings.map((setting) => [setting.tier, setting.label])),
      rateMembershipLabelResolver: rateResolver,
    });
    return {
      kind: "PDF",
      body: renderBookingInvoicePdf(data, format),
      fileName: bookingInvoiceFileName(booking.id, null),
      source: "GENERATED",
    };
  } catch (error) {
    if (error instanceof Error && error.name === "BookingInvoiceUnpricedNightError") {
      return { kind: "CANNOT_GENERATE", message: error.message };
    }
    throw error;
  }
}
