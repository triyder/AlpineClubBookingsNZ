import { formatDollarsDisplay } from "@/lib/finance-format";

/**
 * Ordered palette for mix/breakdown charts (pies, stacked bars). Intentionally
 * kept as literal brand hex rather than CSS-variable tokens (#1801): these feed
 * Recharts `fill`/`stroke` props as concrete categorical colours, and the eight
 * saturated brand tones stay legible in both light and dark mode. Chart neutrals
 * (axis/grid/tooltip) ARE tokenised in trend-chart.tsx so they follow the theme.
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
