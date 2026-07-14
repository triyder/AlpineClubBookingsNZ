import Link from "next/link";

/**
 * Consistent "back to parent hub" affordance for admin drill-down leaf pages.
 *
 * Renders the same styled link the Booking Policies leaves established so every
 * hub leaf returns to a predictable *static* parent hub (not browser history —
 * important on kiosk/touch where there may be no history to go back to). Pass
 * the parent hub's route as `href` and its human name as `label`; the component
 * prepends the ← affordance and the shared underline styling.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="text-sm font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
    >
      ← {label}
    </Link>
  );
}
