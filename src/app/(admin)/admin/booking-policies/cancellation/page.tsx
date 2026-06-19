import Link from "next/link";
import { DefaultCancellationPolicySection } from "@/components/admin/booking-policies/default-cancellation-policy-section";

export default function CancellationPolicyPage() {
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
          Default Cancellation Policy
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Refund rules applied to all bookings unless a date-specific period
          overrides them.
        </p>
      </div>

      <DefaultCancellationPolicySection />
    </div>
  );
}
