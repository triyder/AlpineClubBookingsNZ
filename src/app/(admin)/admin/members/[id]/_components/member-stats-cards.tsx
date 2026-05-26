"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Calendar, Clock, CreditCard, User } from "lucide-react"
import { formatCents } from "@/lib/utils"
import { formatAgeYearsMonths } from "@/lib/member-age"
import { formatMemberDateNz } from "@/lib/admin-member-detail-helpers"
import type { MemberDetail } from "../_types"

export function MemberStatsCards({ member }: { member: MemberDetail }) {
  const memberExactAge = member.dateOfBirth
    ? formatAgeYearsMonths(member.dateOfBirth)
    : null

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <User className="h-8 w-8 text-slate-400" />
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Age Tier</p>
              <p className="text-lg font-semibold">
                {member.ageTier.charAt(0) + member.ageTier.slice(1).toLowerCase()}
              </p>
              {member.dateOfBirth && (
                <p className="text-xs text-slate-400">
                  DOB: {formatMemberDateNz(member.dateOfBirth)}
                  {memberExactAge ? ` (${memberExactAge})` : ""}
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <Calendar className="h-8 w-8 text-slate-400" />
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Total Bookings</p>
              <p className="text-lg font-semibold">{member.stats.totalBookings}</p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <CreditCard className="h-8 w-8 text-slate-400" />
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Total Spend</p>
              <p className="text-lg font-semibold">{formatCents(member.stats.totalSpendCents)}</p>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-3">
            <Clock className="h-8 w-8 text-slate-400" />
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Last Stay</p>
              <p className="text-lg font-semibold">
                {member.stats.lastStay ? formatMemberDateNz(member.stats.lastStay) : "Never"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
