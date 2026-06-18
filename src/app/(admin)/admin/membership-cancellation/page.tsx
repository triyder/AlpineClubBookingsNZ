import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { MembershipCancellationSettingsPanel } from "@/components/admin/membership-cancellation-settings-panel";

export default function MembershipCancellationPage() {
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
          Membership Cancellation
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Configure cancellation copy and Xero handling for member cancellation
          requests.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <MembershipCancellationSettingsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
