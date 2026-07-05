import Link from "next/link";
import { DefaultCancellationPolicySection } from "@/components/admin/booking-policies/default-cancellation-policy-section";
import {
  detectStaleHoldPolicyCopy,
  holdCopyTitle,
} from "@/lib/hold-policy-copy";

export default async function CancellationPolicyPage() {
  const staleHoldCopy = await detectStaleHoldPolicyCopy();

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

      {staleHoldCopy.length > 0 && (
        <div
          role="status"
          className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
        >
          <p className="font-medium">Public copy may be out of date</p>
          <p className="mt-1">
            Your{" "}
            {staleHoldCopy.map((slug, index) => (
              <span key={slug}>
                {index > 0 && (index === staleHoldCopy.length - 1 ? " and " : ", ")}
                <strong>{holdCopyTitle(slug)}</strong>
              </span>
            ))}{" "}
            {staleHoldCopy.length > 1 ? "pages still describe" : "page still describes"}{" "}
            the old non-member hold behaviour and don&rsquo;t mention the{" "}
            <strong>First Paid, First In</strong> option. If you change the
            Members First policy below, review this copy so it matches what
            guests are told.
          </p>
          <p className="mt-2">
            <Link
              href="/admin/page-content"
              className="font-medium underline underline-offset-4"
            >
              Edit public pages
            </Link>
          </p>
        </div>
      )}

      <DefaultCancellationPolicySection />
    </div>
  );
}
