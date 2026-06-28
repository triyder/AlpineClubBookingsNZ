import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { BookingMessagesPanel } from "@/components/admin/booking-messages/booking-messages-panel";

export default function BookingMessagesPage() {
  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/admin/notifications"
          className="text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          ← Notifications &amp; Email
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Booking Messages
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Edit member-facing copy used by booking, payment, cancellation, and
          group booking screens.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <BookingMessagesPanel />
        </CardContent>
      </Card>
    </div>
  );
}
