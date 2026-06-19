import Link from "next/link";
import { PublicBookingRequestsSection } from "@/components/admin/booking-policies/public-booking-requests-section";

export default function PublicBookingRequestsPage() {
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
          Public Booking Requests
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Control whether the public booking request form shows indicative
          pricing to non-members.
        </p>
      </div>

      <PublicBookingRequestsSection />
    </div>
  );
}
