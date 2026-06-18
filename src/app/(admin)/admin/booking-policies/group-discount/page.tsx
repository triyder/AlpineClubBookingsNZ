import Link from "next/link";
import { GroupDiscountSection } from "@/components/admin/booking-policies/group-discount-section";

export default function GroupDiscountPage() {
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
          Group Discount
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Charge all guests at member rates once a booking reaches a minimum
          group size.
        </p>
      </div>

      <GroupDiscountSection />
    </div>
  );
}
