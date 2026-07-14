import Link from "next/link";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  XCircle,
  CalendarRange,
  Users,
  CalendarClock,
  Globe,
} from "lucide-react";

const sections = [
  {
    href: "/admin/booking-policies/cancellation",
    title: "Default Cancellation Policy",
    description:
      "Refund rules applied to all bookings unless a period overrides them.",
    icon: XCircle,
  },
  {
    href: "/admin/booking-policies/periods",
    title: "Date-Specific Periods",
    description:
      "Override the default cancellation policy for specific date ranges.",
    icon: CalendarRange,
  },
  {
    href: "/admin/booking-policies/group-discount",
    title: "Group Discount",
    description:
      "Charge all guests at member rates once a booking reaches a minimum size.",
    icon: Users,
  },
  {
    href: "/admin/booking-policies/minimum-stay",
    title: "Minimum Night Stay",
    description:
      "Require minimum nights when a booking touches certain days of the week.",
    icon: CalendarClock,
  },
  {
    href: "/admin/booking-policies/public-requests",
    title: "Public Booking Requests",
    description:
      "Control whether the public request form shows indicative pricing.",
    icon: Globe,
  },
];

export default function BookingPoliciesHubPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Booking Policies</h1>
        <p className="mt-1 text-sm text-slate-500">
          Configure cancellation refund rules, date-specific overrides, group
          discounts, minimum-stay requirements, and public request settings.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map(({ href, title, description, icon: Icon }) => (
          <Link key={href} href={href} className="group block">
            <Card className="h-full transition-colors hover:border-brand-gold/70">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5 shrink-0 text-foreground" />
                  <CardTitle>{title}</CardTitle>
                </div>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
