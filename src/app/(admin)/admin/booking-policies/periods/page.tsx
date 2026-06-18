import Link from "next/link";
import { BookingPeriodsSection } from "@/components/admin/booking-policies/booking-periods-section";

export default function BookingPeriodsPage() {
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
          Date-Specific Periods
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Override the default cancellation policy for specific date ranges.
        </p>
      </div>

      <BookingPeriodsSection />
    </div>
  );
}
