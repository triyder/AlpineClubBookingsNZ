import { BackLink } from "@/components/admin/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  resolveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import { AdminNotificationSettings } from "../notifications/notifications-settings";

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
    preferences: resolveAdminNotificationPreferences(
      admin.notificationPreference,
    ),
  }));
}

export default async function NotificationRecipientsPage() {
  const admins = await getAdminUsers();

  return (
    <div className="space-y-8">
      <div>
        <BackLink href="/admin/notifications" label="Notifications & Email" />
        <h1 className="mt-2 text-2xl font-bold text-slate-900">Recipients</h1>
        <p className="mt-1 text-sm text-slate-500">
          Choose which system alerts each active admin receives. Changes save
          automatically. New admin alert types default to enabled.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <AdminNotificationSettings initialAdmins={admins} />
        </CardContent>
      </Card>
    </div>
  );
}
