/**
 * Draws the generated booking invoice (fork #115) with jsPDF, on the server.
 *
 * It only lays out what `buildBookingInvoiceData` decided: no money is worked
 * out here beyond formatting cents. The table header repeats on every page.
 */
import { jsPDF } from "jspdf";

import type { BookingInvoiceData, BookingInvoiceLine } from "@/lib/booking-invoice";
import type { ClubFormat } from "@/lib/club-format";
import { formatCents } from "@/lib/utils";

const PAGE = { width: 210, height: 297, margin: 18 } as const;
const FOOTER_Y = PAGE.height - 12;
const CONTENT_BOTTOM = PAGE.height - 24;
const LINE = 5;

// Column right edges / left edges for the line table (mm).
const COLUMNS = {
  guest: PAGE.margin,
  category: 74,
  nightsRight: 140,
  rateRight: 166,
  amountRight: PAGE.width - PAGE.margin,
} as const;

/**
 * jsPDF's built-in Helvetica covers WinAnsi only. Names can carry macrons and
 * other letters outside it (Māori names, for example), which would print as
 * garbage, so anything outside Latin-1 is folded to its base letter, or "?"
 * when it has none.
 */
export function pdfSafeText(value: string): string {
  let out = "";
  for (const char of value) {
    if (char.codePointAt(0)! <= 0xff || "•–—‘’“”€".includes(char)) {
      out += char;
      continue;
    }
    const folded = char.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    out += folded && [...folded].every((c) => c.codePointAt(0)! <= 0xff) ? folded : "?";
  }
  return out;
}

export function renderBookingInvoicePdf(
  data: BookingInvoiceData,
  format: ClubFormat,
): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const money = (cents: number) => pdfSafeText(formatCents(cents, format));
  const text = (
    value: string,
    x: number,
    y: number,
    options?: { align?: "left" | "right" | "center"; maxWidth?: number },
  ) => doc.text(pdfSafeText(value), x, y, options);
  const right = { align: "right" as const };

  // --- Header: issuer on the left, INVOICE on the right --------------------
  let y = PAGE.margin + 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  text(data.issuer.lodgeName, PAGE.margin, y);
  doc.setFontSize(22);
  text("INVOICE", COLUMNS.amountRight, y + 2, right);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  y += 6;
  for (const line of [
    ...data.issuer.addressLines,
    data.issuer.contactLine,
    ...(data.issuer.gstNumber ? [`GST Number: ${data.issuer.gstNumber}`] : []),
  ]) {
    text(line, PAGE.margin, y);
    y += LINE;
  }

  // Invoice number and date, right-aligned under INVOICE.
  let metaY = PAGE.margin + 14;
  for (const [label, value] of [
    ["Invoice number", data.invoiceNumber ?? ""],
    ["Invoice date", data.invoiceDate],
  ] as const) {
    doc.setFont("helvetica", "bold");
    text(`${label}:`, COLUMNS.rateRight - 2, metaY, right);
    doc.setFont("helvetica", "normal");
    text(value, COLUMNS.amountRight, metaY, right);
    metaY += LINE;
  }

  // --- Bill to and stay ------------------------------------------------------
  y = Math.max(y, metaY) + 6;
  doc.setFont("helvetica", "bold");
  text("Bill to", PAGE.margin, y);
  text("Stay", COLUMNS.category + 20, y);
  doc.setFont("helvetica", "normal");
  y += LINE;
  text(data.billTo, PAGE.margin, y, { maxWidth: COLUMNS.category - PAGE.margin + 14 });
  text(`Check-in: ${data.stay.checkIn}`, COLUMNS.category + 20, y);
  text(`Check-out: ${data.stay.checkOut}`, COLUMNS.category + 20, y + LINE);
  text(
    `${data.stay.nights} night${data.stay.nights === 1 ? "" : "s"} • ${data.stay.guests} guest${data.stay.guests === 1 ? "" : "s"}`,
    COLUMNS.category + 20,
    y + LINE * 2,
  );
  y += LINE * 3 + 6;

  // --- Line table ----------------------------------------------------------
  const drawTableHeader = () => {
    doc.setFillColor(235, 235, 235);
    doc.rect(PAGE.margin, y - 4, PAGE.width - PAGE.margin * 2, 7, "F");
    doc.setFont("helvetica", "bold");
    text("Guest", COLUMNS.guest + 1, y);
    text("Category", COLUMNS.category, y);
    text("Nights", COLUMNS.nightsRight, y, right);
    text("Rate / night", COLUMNS.rateRight, y, right);
    text("Amount", COLUMNS.amountRight - 1, y, right);
    doc.setFont("helvetica", "normal");
    y += 8;
  };
  const ensureRoom = (needed: number, withHeader: boolean) => {
    if (y + needed <= CONTENT_BOTTOM) return;
    doc.addPage();
    y = PAGE.margin + 4;
    if (withHeader) drawTableHeader();
  };

  drawTableHeader();
  const drawLine = (line: BookingInvoiceLine) => {
    ensureRoom(LINE + 1, true);
    if (line.kind === "GUEST") {
      text(line.guest, COLUMNS.guest + 1, y, { maxWidth: COLUMNS.category - COLUMNS.guest - 3 });
      text(line.category, COLUMNS.category, y, { maxWidth: COLUMNS.nightsRight - COLUMNS.category - 14 });
      text(String(line.nights), COLUMNS.nightsRight, y, right);
      text(money(line.ratePerNightCents), COLUMNS.rateRight, y, right);
    } else {
      text(line.description, COLUMNS.guest + 1, y, { maxWidth: COLUMNS.rateRight - COLUMNS.guest - 20 });
    }
    text(money(line.amountCents), COLUMNS.amountRight - 1, y, right);
    y += LINE + 1;
  };
  data.lines.forEach(drawLine);

  // --- Totals ----------------------------------------------------------------
  const totalRows: Array<[string, string, boolean]> = [
    ["Subtotal", money(data.subtotalCents), false],
    [`TOTAL (${format.currencyCode})`, money(data.totalCents), true],
  ];
  if (data.payments) {
    totalRows.push(
      ["Amount paid", money(data.payments.amountPaidCents), false],
      ["Balance due", money(data.payments.balanceDueCents), true],
    );
  }
  ensureRoom(LINE * (totalRows.length + 2) + 4, false);
  y += 2;
  doc.line(COLUMNS.category + 40, y - 3, COLUMNS.amountRight, y - 3);
  for (const [label, value, bold] of totalRows) {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    text(label, COLUMNS.rateRight, y, right);
    text(value, COLUMNS.amountRight - 1, y, right);
    y += LINE + 1;
  }
  doc.setFont("helvetica", "normal");
  if (data.includesGst) {
    doc.setFontSize(9);
    text("This amount includes GST", COLUMNS.amountRight - 1, y, right);
    doc.setFontSize(10);
    y += LINE;
  }

  // --- Payment details box (only when the lodge has bank details) -----------
  if (data.paymentDetails) {
    const rows = [
      "Please pay by direct credit to",
      ...(data.paymentDetails.accountName ? [`Account name: ${data.paymentDetails.accountName}`] : []),
      ...(data.paymentDetails.accountDetails ?? "")
        .split(/\r?\n/)
        .map((row) => row.trim())
        .filter(Boolean),
      `Reference: ${data.paymentDetails.reference}`,
    ];
    const height = rows.length * LINE + 6;
    ensureRoom(height + 8, false);
    y += 6;
    doc.setDrawColor(150, 150, 150);
    doc.rect(PAGE.margin, y - 5, PAGE.width - PAGE.margin * 2, height);
    rows.forEach((row, index) => {
      doc.setFont("helvetica", index === 0 ? "bold" : "normal");
      text(row, PAGE.margin + 4, y + index * LINE, { maxWidth: PAGE.width - PAGE.margin * 2 - 8 });
    });
    doc.setFont("helvetica", "normal");
    y += height;
  }

  ensureRoom(LINE * 2, false);
  y += 8;
  doc.setFont("helvetica", "bold");
  text("Thank you for your booking", PAGE.width / 2, y, { align: "center" });

  // --- Footer on every page ---------------------------------------------------
  const pages = doc.getNumberOfPages();
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page);
    text(`${data.issuer.lodgeName} • Invoice`, PAGE.margin, FOOTER_Y);
    text(`Page ${page} of ${pages}`, COLUMNS.amountRight, FOOTER_Y, right);
  }

  return Buffer.from(doc.output("arraybuffer"));
}
