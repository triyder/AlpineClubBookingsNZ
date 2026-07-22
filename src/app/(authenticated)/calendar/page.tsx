import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { canManageCalendarEvents } from "@/lib/calendar-access";
import { CalendarView } from "@/components/calendar/calendar-view";
import { CLUB_NAME } from "@/config/club-identity";

export const metadata = {
  title: "Events Calendar",
};

export default async function MemberCalendarPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const canManage = await canManageCalendarEvents(session.user);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-foreground">
          Events Calendar
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upcoming meetings and events at {CLUB_NAME}.
          {canManage
            ? " Click a day to add an event."
            : " Select an event to see its details."}
        </p>
      </div>
      <CalendarView canManage={canManage} />
    </div>
  );
}
