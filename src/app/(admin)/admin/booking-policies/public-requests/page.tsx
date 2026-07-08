import { BackLink } from "@/components/admin/back-link";
import { PublicBookingRequestsSection } from "@/components/admin/booking-policies/public-booking-requests-section";

export default function PublicBookingRequestsPage() {
  return (
    <div className="space-y-6">
      <div>
        <BackLink href="/admin/booking-policies" label="Booking Policies" />
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Public Booking Requests
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Control indicative pricing on the public request form, how long a quote
          link stays valid, and when requesters are reminded before it expires.
        </p>
      </div>

      <PublicBookingRequestsSection />
    </div>
  );
}
