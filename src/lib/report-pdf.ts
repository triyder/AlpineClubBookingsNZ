import jsPDF from "jspdf";
import html2canvas from "html2canvas";

/**
 * Force the light palette onto the off-screen document html2canvas renders from
 * (#2146).
 *
 * The capture is always composited onto a white PDF page (`backgroundColor`
 * below), so a dark-mode operator would otherwise get near-white text on white —
 * a report that looks blank. next-themes marks the active theme with a `dark`
 * class plus an inline `color-scheme` on <html>; dropping both in the CLONE makes
 * every theme token resolve light without flashing the live page the operator is
 * looking at. The class is also cleared from any nested element, so a scoped
 * theme wrapper cannot re-darken part of the capture.
 *
 * Exported for the contract test; `generateReportPDF` is the only caller.
 */
export function forceLightPaletteInClone(clonedDocument: Document): void {
  const root = clonedDocument.documentElement;
  if (root) {
    root.classList.remove("dark");
    root.style.colorScheme = "light";
  }
  for (const element of Array.from(clonedDocument.querySelectorAll(".dark"))) {
    element.classList.remove("dark");
  }
}

export async function generateReportPDF(
  reportElement: HTMLElement,
  dateRange: { from: string; to: string },
  options?: { title?: string }
): Promise<void> {
  // Capture the report content area as a high-res canvas
  // Use foreignObjectRendering: false to avoid SVG/foreignObject issues with Recharts
  const canvas = await html2canvas(reportElement, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: "#ffffff",
    foreignObjectRendering: false,
    allowTaint: true,
    removeContainer: true,
    // Renders the capture in the light palette even when the operator is
    // browsing in dark mode, so the white PDF page never receives white text.
    onclone: forceLightPaletteInClone,
  });

  // A4: 210mm x 297mm
  const pdf = new jsPDF("p", "mm", "a4");
  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 15;
  const contentWidth = pageWidth - margin * 2;

  // Header
  pdf.setFontSize(16);
  pdf.text(options?.title ?? "Reports", margin, margin + 5);
  pdf.setFontSize(10);
  pdf.setTextColor(100, 100, 100);
  pdf.text(`Date range: ${dateRange.from} to ${dateRange.to}`, margin, margin + 12);
  pdf.text(
    `Generated: ${new Date().toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" })}`,
    margin,
    margin + 17
  );
  pdf.setTextColor(0, 0, 0);

  // Thin separator line
  pdf.setDrawColor(200, 200, 200);
  pdf.line(margin, margin + 20, pageWidth - margin, margin + 20);

  // Place captured content as image
  const imgData = canvas.toDataURL("image/png");
  const imgWidth = contentWidth;
  const imgHeight = (canvas.height * imgWidth) / canvas.width;
  const headerHeight = margin + 24;
  const availableFirstPage = pageHeight - headerHeight - margin;

  if (imgHeight <= availableFirstPage) {
    // Fits on one page
    pdf.addImage(imgData, "PNG", margin, headerHeight, imgWidth, imgHeight);
  } else {
    // Multi-page: slice the canvas into page-sized segments
    const scaleFactor = canvas.width / imgWidth;
    let remainingHeight = canvas.height;
    let sourceY = 0;
    let isFirstPage = true;

    while (remainingHeight > 0) {
      const pageAvailable = isFirstPage ? availableFirstPage : pageHeight - margin * 2;
      const sliceHeightMM = Math.min(pageAvailable, remainingHeight / scaleFactor);
      const sliceHeightPx = sliceHeightMM * scaleFactor;

      // Create a temporary canvas for this slice
      const sliceCanvas = document.createElement("canvas");
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = Math.ceil(sliceHeightPx);
      const ctx = sliceCanvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(
          canvas,
          0, sourceY, canvas.width, sliceHeightPx,
          0, 0, canvas.width, sliceHeightPx
        );
      }

      const sliceData = sliceCanvas.toDataURL("image/png");
      const yPos = isFirstPage ? headerHeight : margin;

      if (!isFirstPage) {
        pdf.addPage();
      }
      pdf.addImage(sliceData, "PNG", margin, yPos, imgWidth, sliceHeightMM);

      sourceY += sliceHeightPx;
      remainingHeight -= sliceHeightPx;
      isFirstPage = false;
    }
  }

  // Save
  const dateStr = new Date().toISOString().split("T")[0];
  pdf.save(`tac-report-${dateStr}.pdf`);
}
