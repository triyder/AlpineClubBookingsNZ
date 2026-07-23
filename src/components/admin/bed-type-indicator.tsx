import { BedDouble, BedSingle, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

// Mirrors the Prisma BedType enum (#1675). Declared locally so this
// presentational component depends on neither @prisma/client nor the board's
// type module; the board and setup manager both pass their own string value.
export type BedTypeValue = "SINGLE" | "BUNK_TOP" | "BUNK_BOTTOM" | "DOUBLE";

type BedTypeIcon = typeof BedSingle;

interface BedTypeMeta {
  Icon: BedTypeIcon;
  // A small directional glyph layered next to the bed icon to read as the top
  // or bottom of a stacked bunk.
  StackIcon?: BedTypeIcon;
  label: string;
  // Per-bed-type accent tint (#156) drawn from the generated categorical scales (#2218), so
  // the icon reads its type at a glance in both light and dark. Applied to the
  // icon only; the label keeps its muted text colour.
  tint: string;
}

function bedTypeMeta(bedType: string): BedTypeMeta {
  switch (bedType) {
    case "DOUBLE":
      return { Icon: BedDouble, label: "Double bed", tint: "text-cat3-11" };
    // Both bunk ends share ONE hue (#156): teal read at 20 deg from emerald on a
    // 16px icon was effectively indistinguishable, and top vs bottom is already
    // carried unambiguously by the ChevronUp/ChevronDown glyph. The shared tint
    // just marks "this is a bunk"; the chevron says which end.
    case "BUNK_TOP":
      return {
        Icon: BedSingle,
        StackIcon: ChevronUp,
        label: "Bunk (top)",
        tint: "text-cat6-11",
      };
    case "BUNK_BOTTOM":
      return {
        Icon: BedSingle,
        StackIcon: ChevronDown,
        label: "Bunk (bottom)",
        tint: "text-cat6-11",
      };
    default:
      return { Icon: BedSingle, label: "Single bed", tint: "text-info" };
  }
}

/**
 * Bed-type icon with an always-present accessible label (#1675): the icon is
 * never presented alone. `showLabel` renders the label as visible text (used in
 * the setup manager); otherwise it is screen-reader-only with a hover tooltip
 * (used on the dense allocation board next to the bed name).
 */
export function BedTypeIndicator({
  bedType,
  showLabel = false,
  labelOverride,
  className,
}: {
  bedType: string;
  showLabel?: boolean;
  // Lets a caller show the pairing ("Bunk A · top") in place of the bare type
  // while keeping the same icon and tooltip.
  labelOverride?: string;
  className?: string;
}) {
  const { Icon, StackIcon, label, tint } = bedTypeMeta(bedType);
  const text = labelOverride ?? label;

  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      title={text}
    >
      <span
        className={cn("relative inline-flex items-center", tint)}
        aria-hidden="true"
      >
        <Icon className="h-4 w-4 shrink-0" />
        {StackIcon ? <StackIcon className="h-3 w-3 shrink-0" /> : null}
      </span>
      {showLabel ? (
        <span className="text-xs text-muted-foreground">{text}</span>
      ) : (
        <span className="sr-only">{text}</span>
      )}
    </span>
  );
}
