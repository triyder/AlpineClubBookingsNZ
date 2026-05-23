import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  resolveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import { listNotificationDeliveryPolicySettings } from "@/lib/notification-delivery-policies";
import { EmailMessageSettingsPanel } from "@/components/admin/email-settings/email-message-settings-panel";
import { NotificationDeliveryPolicySettings } from "@/components/admin/email-settings/notification-delivery-policy-settings";
import { AdminNotificationSettings } from "./notifications-settings";

async function getAdminUsers() {
  const admins = await prisma.member.findMany({
    where: { role: "ADMIN", active: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { email: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  return admins.map((admin) => ({
    id: admin.id,
    name: `${admin.firstName} ${admin.lastName}`.trim(),
    email: admin.email,
    preferences: resolveAdminNotificationPreferences(admin.notificationPreference),
  }));
}

export default async function AdminNotificationsPage() {
  const [admins, deliveryPolicySettings] = await Promise.all([
    getAdminUsers(),
    listNotificationDeliveryPolicySettings(),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Notifications</h1>
        <p className="mt-1 text-sm text-slate-500">
          Choose which system alerts each active admin receives.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Delivery Rules</CardTitle>
          <CardDescription>
            Control which admin and system emails are sent when jobs or alerts run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationDeliveryPolicySettings
            initialPolicies={deliveryPolicySettings.policies}
            initialStalePolicyCount={deliveryPolicySettings.stalePolicyCount}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Admin Notification Recipients</CardTitle>
          <CardDescription>
            Changes save automatically. New admin alert types default to enabled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AdminNotificationSettings initialAdmins={admins} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email Messages</CardTitle>
          <CardDescription>
            Edit shared email variables and message wording for audited templates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmailMessageSettingsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
