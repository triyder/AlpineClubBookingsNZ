"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Calendar, Clock, CreditCard, IdCard, User, Wallet } from "lucide-react"
import { formatCents } from "@/lib/utils"
import { formatAgeYearsMonths } from "@/lib/member-age"
import { formatMemberDateNz } from "@/lib/admin-member-detail-helpers"
import { formatAgeTierName } from "@/lib/use-age-tier-options"
import type { MemberDetail } from "../_types"
import type { LucideIcon } from "lucide-react"

interface MemberSummaryStripProps {
  member: MemberDetail
  membershipLabel: string
  creditBalance: number
  creditLoading: boolean
}

function SummaryItem({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon
  label: string
  value: string
  detail?: string | null
}) {
  return (
    <div className="flex items-center gap-3 bg-card px-4 py-3">
      <Icon className="h-6 w-6 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="truncate text-sm font-semibold">{value}</p>
        {detail ? (
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        ) : null}
      </div>
    </div>
  )
}

export function MemberSummaryStrip({
  member,
  membershipLabel,
  creditBalance,
  creditLoading,
}: MemberSummaryStripProps) {
  const memberExactAge = member.dateOfBirth
    ? formatAgeYearsMonths(member.dateOfBirth)
    : null

  return (
    <Card className="overflow-hidden">
      <CardContent className="grid grid-cols-1 gap-px bg-border p-0 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <SummaryItem
          icon={User}
          label="Age Tier"
          value={formatAgeTierName(member.ageTier)}
          detail={
            member.dateOfBirth
              ? `DOB: ${formatMemberDateNz(member.dateOfBirth)}${memberExactAge ? ` (${memberExactAge})` : ""}`
              : null
          }
        />
        <SummaryItem
          icon={IdCard}
          label="Membership"
          value={membershipLabel}
          detail={`${member.currentSeasonYear}/${member.currentSeasonYear + 1} season`}
        />
        <SummaryItem
          icon={Wallet}
          label="Credit"
          value={creditLoading ? "—" : formatCents(creditBalance)}
        />
        <SummaryItem
          icon={Calendar}
          label="Total Bookings"
          value={String(member.stats.totalBookings)}
        />
        <SummaryItem
          icon={CreditCard}
          label="Total Spend"
          value={formatCents(member.stats.totalSpendCents)}
        />
        <SummaryItem
          icon={Clock}
          label="Last Stay"
          value={
            member.stats.lastStay
              ? formatMemberDateNz(member.stats.lastStay)
              : "Never"
          }
        />
      </CardContent>
    </Card>
  )
}
