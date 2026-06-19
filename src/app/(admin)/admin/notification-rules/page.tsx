import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { listNotificationDeliveryPolicySettings } from "@/lib/notification-delivery-policies";
import { NotificationDeliveryPolicySettings } from "@/components/admin/email-settings/notification-delivery-policy-settings";

export default async function NotificationRulesPage() {
  const deliveryPolicySettings = await listNotificationDeliveryPolicySettings();

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
          Delivery Rules
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Control which admin and system emails are sent when jobs or alerts
          run.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <NotificationDeliveryPolicySettings
            initialPolicies={deliveryPolicySettings.policies}
            initialStalePolicyCount={deliveryPolicySettings.stalePolicyCount}
          />
        </CardContent>
      </Card>
    </div>
  );
}
