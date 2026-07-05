/**
 * Historical Xero invoice rounding-drift audit (issue #1318, read-only).
 *
 * PR #1231 fixed issue #1163: before it, `buildInvoiceLineItems` grouped a
 * guest's nights into contiguous **date** runs only (issue #713) and billed each
 * run as `quantity: nightCount, unitAmount: round(totalCents / nightCount) / 100`.
 * When a single contiguous run mixed nightly prices (a season boundary, or
 * locked-vs-re-priced nights), `nightCount * round(totalCents / nightCount)` could
 * not represent the exact cent total, so the issued Xero invoice's guest-line
 * total drifted 1–2 cents from the true ledger. The same rounding also bit the
 * legacy no-per-night path whenever `guest.priceCents` was not divisible by the
 * night count. #1231 split every run to a single price so the lines reconcile by
 * construction — but it did NOT retroactively heal invoices already issued.
 *
 * This module is a **diagnostic only**. It replays the pre-#1231 line maths over
 * persisted booking/guest/night data — entirely in integer cents — and flags
 * issued invoices whose guest-line total would have drifted. It makes ZERO live
 * provider calls (no Xero, no Stripe), opens no transactions, and mutates
 * nothing. See `scripts/audit-xero-invoice-rounding.ts` for the operator CLI and
 * `docs/xero/ARCHITECTURE.md` for the fresh-install / fork stance.
 *
 * IMPORTANT: a flag means "this booking's data would have produced a drifting
 * line total under the pre-#1231 builder." It does NOT prove the live Xero
 * invoice is still wrong: the invoice may have been issued after #1231 was
 * deployed (already correct), or since voided/credited/superseded. Operators
 * must confirm against Xero before treating a flag as a real accounting error.
 */

import { formatDate } from "./xero-invoice-helpers";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export interface AuditGuestNight {
  stayDate: Date;
  priceCents: number;
}

export interface AuditGuest {
  firstName: string;
  lastName: string;
  ageTier: string;
  isMember: boolean;
  priceCents: number;
  // Per-night rows (issue #713). Empty/null => legacy flat-total path.
  nights?: AuditGuestNight[] | null;
}

/** One contiguous pre-#1231 date run and the drift its rounding introduced. */
export interface DriftRun {
  startDate: string; // YYYY-MM-DD
  endExclusive: string; // YYYY-MM-DD
  nightCount: number;
  /** True cent ledger for the run (sum of the nights' prices). */
  totalCents: number;
  /** The rounded per-night amount the old builder billed: round(totalCents/n). */
  roundedPerNightCents: number;
  /** What Xero charged for the run: nightCount * roundedPerNightCents. */
  emittedTotalCents: number;
  /** emittedTotalCents - totalCents. Non-zero => this run drifted. */
  driftCents: number;
  /** True when nights within the run mixed prices (the #1163 trigger). */
  mixedPrices: boolean;
}

export interface GuestDrift {
  guestName: string;
  ageTier: string;
  isMember: boolean;
  /** Only the runs that actually drifted (driftCents !== 0). */
  driftedRuns: DriftRun[];
  /** Sum of driftCents across the guest's runs. */
  guestDriftCents: number;
}

export interface InvoiceRoundingDrift {
  bookingId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  /** Proxy for when the invoice was issued (payment row creation). */
  issuedAtProxy: string | null; // ISO
  /** Signed total drift across all guests, integer cents. */
  totalDriftCents: number;
  guests: GuestDrift[];
}

/**
 * Replay the pre-#1231 grouping for one guest: split into contiguous **date**
 * runs (NO price boundary — that omission is exactly the bug) and, for each run,
 * apply the old `round(totalCents / nightCount)` per-night rounding.
 *
 * This intentionally reproduces the old code byte-for-byte, including the same
 * float `Math.round(...)` and the same `formatDate`-based contiguity check, so
 * it detects the exact half-cent cases the audit exists to find. Do not
 * "improve" the rounding here.
 */
export function computeGuestRoundingDrift(
  guest: AuditGuest,
  bookingNights: number
): GuestDrift {
  const guestNights = guest.nights ?? [];
  const runs: DriftRun[] = [];

  if (guestNights.length === 0) {
    // Legacy flat-total path. The old builder emitted a single line
    // `quantity: nights, unitAmount: round(priceCents / nights) / 100`.
    // A degenerate range (nights <= 0) emitted quantity 0 in BOTH the old and
    // new builders (identical output), so it carries no #1163 drift — skip it.
    if (bookingNights > 0) {
      const rounded = Math.round(guest.priceCents / bookingNights);
      const emitted = bookingNights * rounded;
      runs.push({
        startDate: "",
        endExclusive: "",
        nightCount: bookingNights,
        totalCents: guest.priceCents,
        roundedPerNightCents: rounded,
        emittedTotalCents: emitted,
        driftCents: emitted - guest.priceCents,
        mixedPrices: false, // flat total, no per-night detail
      });
    }
  } else {
    // Per-night path: contiguous DATE runs, mirroring the pre-#1231
    // groupNightsIntoRuns (which did NOT split on price change).
    const sorted = [...guestNights].sort(
      (a, b) => a.stayDate.getTime() - b.stayDate.getTime()
    );
    interface RawRun {
      startDate: Date;
      endExclusive: Date;
      nightCount: number;
      totalCents: number;
      minPrice: number;
      maxPrice: number;
    }
    const rawRuns: RawRun[] = [];
    for (const night of sorted) {
      const last = rawRuns[rawRuns.length - 1];
      const contiguous =
        last !== undefined &&
        formatDate(new Date(last.endExclusive)) === formatDate(night.stayDate);
      if (last && contiguous) {
        // Pre-#1231: extend on date contiguity ALONE (no price check).
        last.endExclusive = new Date(night.stayDate.getTime() + ONE_DAY_MS);
        last.nightCount += 1;
        last.totalCents += night.priceCents;
        last.minPrice = Math.min(last.minPrice, night.priceCents);
        last.maxPrice = Math.max(last.maxPrice, night.priceCents);
      } else {
        rawRuns.push({
          startDate: night.stayDate,
          endExclusive: new Date(night.stayDate.getTime() + ONE_DAY_MS),
          nightCount: 1,
          totalCents: night.priceCents,
          minPrice: night.priceCents,
          maxPrice: night.priceCents,
        });
      }
    }
    for (const raw of rawRuns) {
      const rounded =
        raw.nightCount > 0
          ? Math.round(raw.totalCents / raw.nightCount)
          : raw.totalCents;
      const emitted = raw.nightCount * rounded;
      runs.push({
        startDate: formatDate(new Date(raw.startDate)),
        endExclusive: formatDate(new Date(raw.endExclusive)),
        nightCount: raw.nightCount,
        totalCents: raw.totalCents,
        roundedPerNightCents: rounded,
        emittedTotalCents: emitted,
        driftCents: emitted - raw.totalCents,
        mixedPrices: raw.minPrice !== raw.maxPrice,
      });
    }
  }

  const driftedRuns = runs.filter((run) => run.driftCents !== 0);
  const guestDriftCents = driftedRuns.reduce((sum, run) => sum + run.driftCents, 0);

  return {
    guestName: `${guest.firstName} ${guest.lastName}`.trim(),
    ageTier: guest.ageTier,
    isMember: guest.isMember,
    driftedRuns,
    guestDriftCents,
  };
}

export interface BookingRoundingDriftInput {
  bookingId: string;
  xeroInvoiceId: string | null;
  xeroInvoiceNumber: string | null;
  issuedAtProxy: Date | string | null;
  bookingNights: number;
  guests: AuditGuest[];
}

/**
 * Compute the total pre-#1231 rounding drift for one booking's issued invoice.
 * Returns null when nothing drifted (the invoice is clean). Promo/entrance/
 * supplementary lines are `quantity: 1` exact-cent lines and never contribute
 * drift, so they are deliberately not modelled here.
 */
export function computeBookingRoundingDrift(
  input: BookingRoundingDriftInput
): InvoiceRoundingDrift | null {
  // A booking is a candidate iff at least one run drifted. Net drift can be
  // zero while individual runs differ (rare ± cases); keep such invoices, since
  // their line totals were still individually wrong under the old builder.
  const guests = input.guests
    .map((guest) => computeGuestRoundingDrift(guest, input.bookingNights))
    .filter((guest) => guest.driftedRuns.length > 0);

  if (guests.length === 0) return null;

  const totalDriftCents = guests.reduce((sum, g) => sum + g.guestDriftCents, 0);

  const issuedAtProxy =
    input.issuedAtProxy == null
      ? null
      : input.issuedAtProxy instanceof Date
        ? input.issuedAtProxy.toISOString()
        : input.issuedAtProxy;

  return {
    bookingId: input.bookingId,
    xeroInvoiceId: input.xeroInvoiceId,
    xeroInvoiceNumber: input.xeroInvoiceNumber,
    issuedAtProxy,
    totalDriftCents,
    guests,
  };
}

// ---------------------------------------------------------------------------
// Read-only DB scanner
// ---------------------------------------------------------------------------

/** Minimal read surface the scanner needs; satisfied by the Prisma client. */
export interface RoundingAuditBooking {
  id: string;
  checkIn: Date;
  checkOut: Date;
  payment: {
    xeroInvoiceId: string | null;
    xeroInvoiceNumber: string | null;
    createdAt: Date;
  } | null;
  guests: Array<{
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    priceCents: number;
    nights: Array<{ stayDate: Date; priceCents: number }>;
  }>;
}

export interface RoundingAuditPrismaClient {
  booking: {
    findMany: (args: {
      where: Record<string, unknown>;
      include: Record<string, unknown>;
      orderBy: Record<string, unknown>;
      take: number;
      skip?: number;
      cursor?: { id: string };
    }) => Promise<RoundingAuditBooking[]>;
  };
}

export interface RoundingAuditScanOptions {
  /**
   * Only scan invoices whose issued-at proxy (`payment.createdAt`) is strictly
   * before this instant. Set it to the date you deployed #1231 to exclude
   * already-correct invoices. Omit to scan every issued invoice.
   */
  issuedBefore?: Date | null;
  /** Page size for cursor pagination (default 200). */
  batchSize?: number;
  /** Optional cap on returned affected invoices (diagnostics). */
  limit?: number;
}

export interface RoundingAuditScanResult {
  scannedInvoices: number;
  affected: InvoiceRoundingDrift[];
  totalDriftCents: number;
  affectedCount: number;
  issuedBefore: string | null;
}

/**
 * Count the nights in a stay the same way the pricing engine does: whole
 * date-only nights from checkIn (inclusive) to checkOut (exclusive).
 */
export function countStayNights(checkIn: Date, checkOut: Date): number {
  const start = Date.UTC(
    checkIn.getUTCFullYear(),
    checkIn.getUTCMonth(),
    checkIn.getUTCDate()
  );
  const end = Date.UTC(
    checkOut.getUTCFullYear(),
    checkOut.getUTCMonth(),
    checkOut.getUTCDate()
  );
  const diff = Math.round((end - start) / ONE_DAY_MS);
  return diff > 0 ? diff : 0;
}

/**
 * Scan every issued booking invoice for pre-#1231 rounding drift, reading in
 * cursor-paginated batches so it never loads the whole table at once and never
 * opens a transaction. Read-only: it only issues `booking.findMany`.
 */
export async function scanXeroInvoiceRoundingDrift(
  client: RoundingAuditPrismaClient,
  options: RoundingAuditScanOptions = {}
): Promise<RoundingAuditScanResult> {
  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : 200;
  const issuedBefore = options.issuedBefore ?? null;

  const paymentWhere: Record<string, unknown> = { xeroInvoiceId: { not: null } };
  if (issuedBefore) {
    paymentWhere.createdAt = { lt: issuedBefore };
  }

  const affected: InvoiceRoundingDrift[] = [];
  let scannedInvoices = 0;
  let totalDriftCents = 0;
  let cursorId: string | null = null;

  for (;;) {
    const batch = await client.booking.findMany({
      where: { payment: { is: paymentWhere } },
      include: {
        payment: {
          select: {
            xeroInvoiceId: true,
            xeroInvoiceNumber: true,
            createdAt: true,
          },
        },
        guests: {
          include: { nights: { select: { stayDate: true, priceCents: true } } },
        },
      },
      orderBy: { id: "asc" },
      take: batchSize,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });

    if (batch.length === 0) break;

    for (const booking of batch) {
      if (!booking.payment?.xeroInvoiceId) continue;
      scannedInvoices += 1;
      const drift = computeBookingRoundingDrift({
        bookingId: booking.id,
        xeroInvoiceId: booking.payment.xeroInvoiceId,
        xeroInvoiceNumber: booking.payment.xeroInvoiceNumber,
        issuedAtProxy: booking.payment.createdAt,
        bookingNights: countStayNights(booking.checkIn, booking.checkOut),
        guests: booking.guests.map((g) => ({
          firstName: g.firstName,
          lastName: g.lastName,
          ageTier: g.ageTier,
          isMember: g.isMember,
          priceCents: g.priceCents,
          nights: g.nights.map((n) => ({
            stayDate: n.stayDate,
            priceCents: n.priceCents,
          })),
        })),
      });
      if (drift) {
        affected.push(drift);
        totalDriftCents += drift.totalDriftCents;
        if (options.limit && affected.length >= options.limit) {
          return {
            scannedInvoices,
            affected,
            affectedCount: affected.length,
            totalDriftCents,
            issuedBefore: issuedBefore ? issuedBefore.toISOString() : null,
          };
        }
      }
    }

    cursorId = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }

  return {
    scannedInvoices,
    affected,
    affectedCount: affected.length,
    totalDriftCents,
    issuedBefore: issuedBefore ? issuedBefore.toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)} (${cents >= 0 ? "+" : ""}${cents}c)`;
}

/** Render a plain-text operator report for a scan result. */
export function formatRoundingAuditReport(result: RoundingAuditScanResult): string {
  const lines: string[] = [];
  lines.push("Xero invoice rounding-drift audit (#1318) — DIAGNOSTIC, read-only");
  lines.push("=".repeat(70));
  lines.push(`Issued invoices scanned: ${result.scannedInvoices}`);
  lines.push(`Candidate affected invoices: ${result.affectedCount}`);
  lines.push(`Net drift across candidates: ${formatCents(result.totalDriftCents)}`);
  if (result.issuedBefore) {
    lines.push(`Scope: payment.createdAt < ${result.issuedBefore}`);
  } else {
    lines.push(
      "Scope: ALL issued invoices (no --issued-before). Some candidates may " +
        "have been issued AFTER #1231 and are already correct."
    );
  }
  lines.push("");

  if (result.affected.length === 0) {
    lines.push("No candidate invoices matched the pre-#1231 drift pattern.");
    return lines.join("\n");
  }

  lines.push(
    "Each candidate matches the pre-#1231 pattern in LOCAL data only. Before " +
      "treating it as a real error, confirm in Xero that the invoice is still " +
      "live (not voided/credited/superseded) and was issued before you deployed " +
      "#1231. Remediation is a manual accounting correction, not automated here."
  );
  lines.push("");

  for (const invoice of result.affected) {
    lines.push("-".repeat(70));
    lines.push(
      `Invoice ${invoice.xeroInvoiceNumber ?? "(no number)"} ` +
        `[${invoice.xeroInvoiceId ?? "unknown id"}]`
    );
    lines.push(`  Booking: ${invoice.bookingId}`);
    lines.push(`  Issued-at proxy (payment.createdAt): ${invoice.issuedAtProxy ?? "unknown"}`);
    lines.push(`  Total drift: ${formatCents(invoice.totalDriftCents)}`);
    for (const guest of invoice.guests) {
      lines.push(
        `  Guest ${guest.guestName} (${guest.ageTier}` +
          `${guest.isMember ? ", Member" : ", Non-member"}): ` +
          `${formatCents(guest.guestDriftCents)}`
      );
      for (const run of guest.driftedRuns) {
        const range =
          run.startDate && run.endExclusive
            ? `${run.startDate} - ${run.endExclusive}`
            : "flat total (no per-night rows)";
        lines.push(
          `    ${run.nightCount} night(s) ${range}: ledger ${formatCents(
            run.totalCents
          )}, billed ${run.nightCount} x ${formatCents(
            run.roundedPerNightCents
          )} = ${formatCents(run.emittedTotalCents)} -> drift ${formatCents(
            run.driftCents
          )}${run.mixedPrices ? " [mixed nightly prices]" : ""}`
        );
      }
    }
  }

  return lines.join("\n");
}
