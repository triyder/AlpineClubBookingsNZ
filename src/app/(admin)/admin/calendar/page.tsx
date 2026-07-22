import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { canManageCalendarEvents } from "@/lib/calendar-access";
import { CalendarView } from "@/components/calendar/calendar-view";

export const metadata = {
  title: "Calendar",
};

export default async function AdminCalendarPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canManage = await canManageCalendarEvents(session.user);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Club events and committee meetings. Committee members and lodge
          administrators can add, edit, and delete events; everyone else sees a
          read-only view.
        </p>
      </div>
      <CalendarView canManage={canManage} />
    </div>
  );
}
