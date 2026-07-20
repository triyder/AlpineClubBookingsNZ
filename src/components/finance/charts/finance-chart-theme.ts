import { formatDollarsDisplay } from "@/lib/finance-format";

/**
 * Ordered palette for mix/breakdown charts (pies, stacked bars).
 *
 * DECISION — KEEP as literal brand hex, do NOT tokenise (#1801 carve-out,
 * re-affirmed by the owner in #2137). These values feed Recharts `fill` /
 * `stroke` PRESENTATION ATTRIBUTES, where `var()` does not resolve, so a CSS
 * token cannot be substituted here without re-plumbing every chart. They are
 * also deliberately CATEGORICAL: brand tones chosen to stay mutually
 * distinguishable independent of the admin-configured site colours.
 *
 * KNOWN EDGE CASES at the tail of the palette (pre-existing, not introduced by
 * #2137, and NOT fixed here because the keep decision freezes these values):
 * slot 7 `#2f2f2b` is near-invisible against the DARK card (~1.04:1) and slot 8
 * `#d9d5c2` is near-invisible against the LIGHT card (~1.27:1); slot 3
 * `#6a6a63` is marginal. `mix-pie-chart.tsx` draws its Cells without a stroke,
 * so a chart that actually reaches a 7th or 8th category can render a slice
 * that reads as background. Treat the first six tones as the safe set; changing
 * the palette or adding a cell stroke needs an owner decision.
 *
 * Chart NEUTRALS (grid, axis, ticks) are handled differently: `trend-chart.tsx`
 * still passes literal `stroke="#e2e8f0"` / `"#94a3b8"` for the same
 * SVG-attribute reason, but those literals are only the light-mode fallback —
 * `globals.css` overrides them for real via `.finance-trend-chart .recharts-*`
 * selectors, which DO follow the theme (including dark mode). See the in-file
 * comment at `trend-chart.tsx` `sharedAxes`.
 */
export const FINANCE_MIX_COLORS = [
  "#ffcb05",
  "#ff7c12",
  "#6a6a63",
  "#2563eb",
  "#16a34a",
  "#9333ea",
  "#2f2f2b",
  "#d9d5c2",
] as const;

export type FinanceValueType = "currency" | "count" | "percent" | "ratio";

const wholeNumber = new Intl.NumberFormat("en-NZ", {
  maximumFractionDigits: 0,
});

const percentFormatter = new Intl.NumberFormat("en-NZ", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Ratios (e.g. the current ratio) are not integers; show two decimal places so
// values like 1.35 are not rounded to "1".
const ratioFormatter = new Intl.NumberFormat("en-NZ", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Display value for tooltips and labels (currency: whole dollars). */
export function formatFinanceValue(
  value: number,
  valueType: FinanceValueType
): string {
  switch (valueType) {
    case "currency":
      return formatDollarsDisplay(value);
    case "percent":
      return percentFormatter.format(value);
    case "ratio":
      return ratioFormatter.format(value);
    case "count":
    default:
      return wholeNumber.format(value);
  }
}

/** Compact value for chart axis ticks (e.g. "$10k", "1.2k", "5%"). */
export function formatFinanceAxisTick(
  value: number,
  valueType: FinanceValueType
): string {
  if (valueType === "percent") {
    return percentFormatter.format(value);
  }

  if (valueType === "ratio") {
    return ratioFormatter.format(value);
  }

  if (valueType === "currency") {
    const dollars = value / 100;
    const abs = Math.abs(dollars);
    if (abs >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}m`;
    if (abs >= 1_000) return `$${Math.round(dollars / 1_000)}k`;
    return `$${Math.round(dollars)}`;
  }

  const abs = Math.abs(value);
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return wholeNumber.format(value);
}
