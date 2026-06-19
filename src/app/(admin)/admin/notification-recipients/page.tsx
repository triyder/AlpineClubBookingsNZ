import Link from "next/link";
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
        <Link
          href="/admin/notifications"
          className="text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          ← Notifications &amp; Email
        </Link>
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
