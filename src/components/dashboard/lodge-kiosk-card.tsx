import Link from "next/link";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MEMBER_LODGE_ROSTER_LINK } from "@/lib/member-lodge-roster-link";

/** The member dashboard's Lodge Kiosk tile; `showRoster` is the roster module. */
export function LodgeKioskCard({ showRoster }: { showRoster: boolean }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Lodge Kiosk</CardTitle>
        <Users className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-lg font-semibold">Who is in the lodge</div>
        <p className="text-xs text-muted-foreground mt-1">
          The lodge kiosk will show you who is arriving and leaving the lodge.
        </p>
        <Button asChild size="sm" variant="outline" className="mt-4 w-full">
          <Link href="/lodge/kiosk">Open Kiosk</Link>
        </Button>
        {showRoster && (
          <Button asChild size="sm" variant="outline" className="mt-2 w-full">
            <Link href={MEMBER_LODGE_ROSTER_LINK.href}>
              {MEMBER_LODGE_ROSTER_LINK.label}
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
