"use client"

import type { ReactNode } from "react"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AuditTimeline } from "@/components/audit-timeline"
import { XeroRecordActivityPanel } from "@/components/admin/xero-record-activity-panel"
import { ExternalLink } from "lucide-react"
import {
  bookingStatusClass,
  bookingStatusLabel,
  subscriptionStatusClass,
  subscriptionStatusLabel,
} from "@/lib/status-colors"
import { formatCents } from "@/lib/utils"
import { formatMemberDateNz } from "@/lib/admin-member-detail-helpers"
import type { CollapsibleMemberSection } from "@/lib/admin-member-detail-helpers"
import type { MemberDetail } from "../_types"

interface MemberHistoryAccordionProps {
  memberId: string
  subscriptions: MemberDetail["subscriptions"]
  bookings: MemberDetail["bookings"]
  openSections: CollapsibleMemberSection[]
  onValueChange: (value: string[]) => void
  creditCard: ReactNode
}

export function MemberHistoryAccordion({
  memberId,
  subscriptions,
  bookings,
  openSections,
  onValueChange,
  creditCard,
}: MemberHistoryAccordionProps) {
  return (
    <Accordion type="multiple" value={openSections} onValueChange={onValueChange} className="space-y-6">
      <AccordionItem value="subs" className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow">
        <AccordionTrigger className="px-6 py-6 text-left text-base font-medium hover:no-underline">
          Subscription History
        </AccordionTrigger>
        <AccordionContent className="px-6 pb-6">
          {subscriptions.length === 0 ? (
            <p className="text-sm text-slate-500">No subscription records</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Season Year</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Paid At</TableHead>
                  <TableHead>Xero Invoice</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((sub) => (
                  <TableRow key={sub.id}>
                    <TableCell className="font-medium">
                      {sub.seasonYear}/{sub.seasonYear + 1}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={subscriptionStatusClass(sub.status)}>
                        {subscriptionStatusLabel(sub.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>{sub.paidAt ? formatMemberDateNz(sub.paidAt) : "-"}</TableCell>
                    <TableCell>
                      {sub.xeroInvoiceId ? (
                        <a
                          href={`https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${sub.xeroInvoiceId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline inline-flex items-center gap-1"
                        >
                          View <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        "-"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="bookings" className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow">
        <AccordionTrigger className="px-6 py-6 text-left text-base font-medium hover:no-underline">
          Booking History
        </AccordionTrigger>
        <AccordionContent className="px-6 pb-6">
          {bookings.length === 0 ? (
            <p className="text-sm text-slate-500">No bookings yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check In</TableHead>
                  <TableHead>Check Out</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Guests</TableHead>
                  <TableHead>Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bookings.map((booking) => (
                  <TableRow key={booking.id}>
                    <TableCell>{formatMemberDateNz(booking.checkIn)}</TableCell>
                    <TableCell>{formatMemberDateNz(booking.checkOut)}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={bookingStatusClass(booking.status)}>
                        {bookingStatusLabel(booking.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>{booking._count.guests}</TableCell>
                    <TableCell>{formatCents(booking.finalPriceCents)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </AccordionContent>
      </AccordionItem>

      {creditCard}

      <AccordionItem value="xero" className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow">
        <AccordionTrigger className="px-6 py-6 text-left text-base font-medium hover:no-underline">
          Xero Activity
        </AccordionTrigger>
        <AccordionContent className="px-6 pb-6">
          <XeroRecordActivityPanel localModel="Member" localId={memberId} compact className="border-0 shadow-none" />
        </AccordionContent>
      </AccordionItem>

      <AccordionItem value="audit" className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow">
        <AccordionTrigger className="px-6 py-6 text-left text-base font-medium hover:no-underline">
          Audit Log
        </AccordionTrigger>
        <AccordionContent className="px-6 pb-6">
          <AuditTimeline endpoint={`/api/admin/members/${memberId}/audit-log`} showMetadata showAdminEntityLinks />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}
