import { SubscriptionLockoutSettingsPanel } from "@/components/admin/subscription-lockout-settings-panel";

export default function AdminSubscriptionLockoutPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Subscription lockout settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn the unpaid-subscription booking lockout on or off, set the
          financial year, and configure how a paid subscription is detected in
          Xero.
        </p>
      </div>

      <SubscriptionLockoutSettingsPanel />
    </div>
  );
}
