import { BackLink } from "@/components/admin/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { MembershipCancellationSettingsPanel } from "@/components/admin/membership-cancellation-settings-panel";

export default function MembershipCancellationPage() {
  return (
    <div className="space-y-8">
      <div>
        <BackLink href="/admin/notifications" label="Notifications & Email" />
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
