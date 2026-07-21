"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  formatMemberDateNz,
  formatPromoBenefit,
} from "@/lib/admin-member-detail-helpers"
import type { MemberPromoCode } from "../_types"

export function MemberPromoCodesCard({ promoCodes, className }: { promoCodes: MemberPromoCode[]; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base font-medium">Promo Codes</CardTitle>
      </CardHeader>
      <CardContent>
        {promoCodes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No promo codes assigned to this member.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Benefit</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Validity</TableHead>
                <TableHead>Usage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {promoCodes.map((promo) => (
                <TableRow key={promo.id || promo.code}>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge variant="secondary" className="font-mono">
                        {promo.code}
                      </Badge>
                      {promo.description && (
                        <p className="max-w-xs text-xs text-muted-foreground">{promo.description}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm font-medium">{formatPromoBenefit(promo)}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <Badge
                        variant="secondary"
                        className={
                          promo.visibleToMember
                            ? "bg-green-100 text-green-800 border-green-200"
                            : "bg-amber-100 text-amber-800 border-amber-200"
                        }
                      >
                        {promo.visibleToMember ? "Visible to member" : "Not currently usable"}
                      </Badge>
                      <p className="text-xs text-muted-foreground">{promo.statusReason}</p>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="space-y-1">
                      <p>Assigned {promo.assignedAt ? formatMemberDateNz(promo.assignedAt) : "unknown"}</p>
                      <p>
                        Valid {promo.validFrom ? formatMemberDateNz(promo.validFrom) : "now"} -{" "}
                        {promo.validUntil ? formatMemberDateNz(promo.validUntil) : "no end"}
                      </p>
                      {(promo.bookingStartFrom || promo.bookingStartUntil) && (
                        <p>
                          Stay dates {promo.bookingStartFrom ? formatMemberDateNz(promo.bookingStartFrom) : "any"} -{" "}
                          {promo.bookingStartUntil ? formatMemberDateNz(promo.bookingStartUntil) : "any"}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    <div className="space-y-1">
                      <p>
                        {promo.currentRedemptions}
                        {promo.maxRedemptionsTotal !== null ? `/${promo.maxRedemptionsTotal}` : ""} total redemptions
                      </p>
                      <p>
                        {promo.redemptionCount}
                        {promo.maxUsesPerMember !== null ? `/${promo.maxUsesPerMember}` : ""} by this member
                      </p>
                      {promo.type === "FREE_NIGHTS" && promo.lifetimeFreeNightsCap !== null && (
                        <p>
                          {promo.freeNightsUsed}/{promo.lifetimeFreeNightsCap} free nights used (lifetime)
                        </p>
                      )}
                      {promo.type === "FREE_NIGHTS" &&
                        promo.lifetimeFreeNightsCap === null &&
                        promo.freeNightsPerIndividual !== null && (
                          <p>
                            {promo.freeNightsUsed} free nights used · {promo.freeNightsPerIndividual} per booking
                          </p>
                        )}
                      {promo.maxUsesPerMember === 1 && <p>Single use per member</p>}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
