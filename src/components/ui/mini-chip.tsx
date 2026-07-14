import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { CHIP_TONE_CLASSES, type ChipTone } from "@/lib/chip-tones";

/**
 * MiniChip — an icon + label pill in one shared tone (#156). Used for the
 * non-status signals the redesigned admin tables keep inline (payment source,
 * Xero state, settlement kind, booking review/deleted flags). It shares its
 * tone -> class map with `StatusChip` via `@/lib/chip-tones`, so the whole chip
 * family stays visually consistent. Meaning is carried by icon + label, never
 * colour alone.
 */
export function MiniChip({
  tone,
  icon: Icon,
  className,
  children,
}: {
  tone: ChipTone;
  icon: LucideIcon;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-transparent px-2 py-0.5 text-xs font-medium",
        CHIP_TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{children}</span>
    </span>
  );
}
