import Link from "next/link";
import { MinimumNightStaySection } from "@/components/admin/booking-policies/minimum-night-stay-section";

export default function MinimumStayPage() {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/booking-policies"
          className="text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          ← Booking Policies
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Minimum Night Stay
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Require a minimum number of nights when a booking touches specific days
          of the week within a date range.
        </p>
      </div>

      <MinimumNightStaySection />
    </div>
  );
}
