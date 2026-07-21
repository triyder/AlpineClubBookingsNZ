import { AGE_TIER_COLORS } from "@/lib/admin-family-group-ui-helpers";

export function AgeTierBadge({ tier }: { tier: string }) {
  const colors = AGE_TIER_COLORS[tier] || "bg-muted text-muted-foreground border-border";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${colors}`}>
      {tier}
    </span>
  );
}
