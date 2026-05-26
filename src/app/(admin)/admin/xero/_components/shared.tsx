"use client"

import { useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { buildHrefWithReturnTo } from "@/lib/internal-return-path"
import { formatRedactedJson } from "@/lib/redact-sensitive-json"
import type {
  AccountMappingKey,
  CreditItemMappingKey,
  SectionKey,
  SyncReport,
  XeroHealthSnapshot,
  XeroOperation,
  XeroReferenceCacheMeta,
  XeroUsageSummary,
} from "./types"

export type ToggleSection = (section: SectionKey, nextOpen: boolean) => void

export function SectionCard({
  id,
  title,
  description,
  open,
  onToggle,
  actions,
  children,
}: {
  id: string
  title: string
  description: string
  open: boolean
  onToggle: (nextOpen: boolean) => void
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <Card id={id} className="mb-6 scroll-mt-24">
      <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
        <button
          type="button"
          onClick={() => onToggle(!open)}
          className="flex w-full items-start justify-between gap-3 text-left md:flex-1"
        >
          <div className="space-y-1">
            <CardTitle>{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          <span className="pt-0.5 text-xs text-muted-foreground">{open ? "v" : ">"}</span>
        </button>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2" onClick={(event) => event.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </CardHeader>
      {open ? <CardContent>{children}</CardContent> : null}
    </Card>
  )
}

export function FilterSelect({
  label,
  value,
  values,
  labels,
  onValueChange,
}: {
  label: string
  value: string
  values: string[]
  labels?: Record<string, string>
  onValueChange: (value: string) => void
}) {
  return (
    <div className="w-full md:w-48">
      <Label className="mb-1 block text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item} value={item}>
              {labels?.[item] ?? (item === "all" ? `All ${label.toLowerCase()}s` : item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function HealthStatCard({
  label,
  value,
  subtitle,
  badge,
  href,
  onClick,
}: {
  label: string
  value: ReactNode
  subtitle: string
  badge?: ReactNode
  href?: string
  onClick?: () => void
}) {
  const className =
    "flex h-full flex-col rounded-xl border bg-white p-4 text-left shadow-sm transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
  const content = (
    <>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
          <div className="mt-2 break-words text-2xl font-semibold leading-tight">{value}</div>
        </div>
        {badge ? <div className="max-w-full shrink-0 [&>*]:whitespace-normal [&>*]:text-center">{badge}</div> : null}
      </div>
      <p className="mt-4 text-sm leading-5 text-muted-foreground">{subtitle}</p>
    </>
  )
  if (href) return <a href={href} className={className}>{content}</a>
  if (onClick) return <button type="button" onClick={onClick} className={`${className} w-full`}>{content}</button>
  return <div className={className}>{content}</div>
}

export function operationStatusClass(status: string) {
  switch (status) {
    case "SUCCEEDED":
    case "PROCESSED":
      return "bg-green-600"
    case "PARTIAL":
      return "bg-amber-500"
    case "FAILED":
      return "bg-red-600"
    case "RUNNING":
    case "PROCESSING":
      return "bg-blue-600"
    default:
      return "bg-slate-600"
  }
}

export function usageToneClass(status: XeroUsageSummary["today"]["budgetStatus"] | undefined) {
  switch (status) {
    case "warning":
      return "bg-amber-500"
    case "critical":
      return "bg-orange-600"
    case "exhausted":
      return "bg-red-600"
    default:
      return "bg-green-600"
  }
}

export function healthBudgetToneClass(status: XeroHealthSnapshot["apiBudget"]["status"]) {
  return status === "unknown" ? "bg-slate-600" : usageToneClass(status)
}

export function failureStateBadgeClass(state: XeroOperation["failureState"]) {
  if (state === "ACTIVE") return "bg-red-600"
  if (state === "REPAIRED") return "bg-green-600"
  if (state === "SUPERSEDED") return "bg-slate-600"
  return ""
}

export function failureStateLabel(state: XeroOperation["failureState"]) {
  if (state === "ACTIVE") return "Active"
  if (state === "REPAIRED") return "Repaired"
  if (state === "SUPERSEDED") return "Superseded"
  return null
}

export function inboundEventActionLabel(status: string) {
  if (status === "FAILED") return "Retry"
  if (status === "RECEIVED") return "Process Now"
  return "Replay"
}

export function shortId(value: string | null | undefined) {
  return value ? (value.length > 12 ? `${value.slice(0, 12)}...` : value) : "-"
}

export function formatJson(value: unknown) {
  return formatRedactedJson(value)
}

export function formatReferenceCacheLabel(label: string, cache: XeroReferenceCacheMeta | null) {
  if (!cache) return `${label}: no cache metadata yet`
  const sourceLabel = cache.source === "database" ? "shared cache" : cache.source === "memory" ? "memory cache" : "live Xero"
  return `${label}: ${sourceLabel}, refreshed ${new Date(cache.lastRefreshedAt).toLocaleString()}, expires ${new Date(cache.expiresAt).toLocaleString()}`
}

export const ACCOUNT_MAPPING_KEYS: AccountMappingKey[] = [
  "hutFeesIncome",
  "hutFeeRefunds",
  "stripeBankAccount",
  "stripeFees",
  "subscriptionIncome",
  "membershipCancellationCredit",
]

export const CREDIT_ITEM_MAPPING_KEYS: CreditItemMappingKey[] = ["hutFeeRefundItem", "membershipCancellationCredit"]

export const MAPPING_LABELS: Record<string, string> = {
  hutFeesIncome: "Hut Fees Income",
  hutFeeRefunds: "Hut Fee Refunds",
  stripeBankAccount: "Stripe Bank Account",
  stripeFees: "Stripe Fees",
  subscriptionIncome: "Subscription Income",
  membershipCancellationCredit: "Membership Cancellation Credits",
  hutFeeRefundItem: "Hut Fee Refund Item",
}

export const MAPPING_DESCRIPTIONS: Record<string, string> = {
  hutFeesIncome: "Sales account for booking income line items",
  hutFeeRefunds: "Account for refund credit notes",
  stripeBankAccount: "Bank account used to record Stripe payments",
  stripeFees: "Expense account for Stripe transaction fees (optional)",
  subscriptionIncome: "Account code used to detect annual subscription invoices",
  membershipCancellationCredit:
    "Credit note account and item used to reverse unpaid annual subscription invoices when membership cancellation is approved",
  hutFeeRefundItem: "Xero Item for refund credit note line items",
}

export const MAPPING_TYPE_FILTER: Record<AccountMappingKey, string> = {
  hutFeesIncome: "REVENUE",
  hutFeeRefunds: "REVENUE",
  stripeBankAccount: "BANK",
  stripeFees: "EXPENSE",
  subscriptionIncome: "REVENUE",
  membershipCancellationCredit: "REVENUE",
}

function SyncReportSection({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string
  count: number
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  if (count === 0) return null
  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium hover:bg-slate-50"
      >
        <span>
          {title} ({count})
        </span>
        <span className="text-xs text-slate-400">{open ? "v" : ">"}</span>
      </button>
      {open ? <div className="space-y-1 border-t px-3 pb-3">{children}</div> : null}
    </div>
  )
}

export function SyncReportView({ report, returnTo }: { report: SyncReport; returnTo: string }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Scanned {report.total} Xero contacts</p>
      <SyncReportSection title="Updated Members" count={report.updated.length}>
        {report.updated.map((member, index) => (
          <div key={`${member.memberId}-${index}`} className="flex items-start justify-between border-b py-1 text-xs last:border-0">
            <div>
              <a href={buildHrefWithReturnTo(`/admin/members/${member.memberId}`, returnTo)} className="font-medium text-blue-600 hover:underline">
                {member.name}
              </a>
              <ul className="mt-0.5 list-inside list-disc text-slate-500">
                {member.changes.map((change) => <li key={change}>{change}</li>)}
              </ul>
            </div>
            <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-blue-600 hover:underline">
              Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Already Linked (No Changes)" count={report.skippedNoChanges}>
        <p className="pt-1 text-xs text-slate-500">{report.skippedNoChanges} contacts were already linked and had no data to update.</p>
      </SyncReportSection>
      <SyncReportSection title="Skipped - Name Mismatch" count={report.skippedNameMismatch.length} defaultOpen>
        {report.skippedNameMismatch.map((mismatch) => (
          <div key={`${mismatch.memberId}-${mismatch.xeroContactId}`} className="flex items-start justify-between gap-3 border-b py-1 text-xs last:border-0">
            <div>
              <a href={buildHrefWithReturnTo(`/admin/members/${mismatch.memberId}`, returnTo)} className="font-medium text-blue-600 hover:underline">
                {mismatch.memberName}
              </a>
              <p className="text-slate-500">{mismatch.memberEmail}</p>
              <p className="text-slate-500">
                Xero contact: {mismatch.xeroContactName}
                {mismatch.xeroContactEmail ? ` (${mismatch.xeroContactEmail})` : ""}
              </p>
              <p className="text-amber-700">{mismatch.reasons.join(", ")}</p>
            </div>
            <a href={`https://go.xero.com/Contacts/View/${mismatch.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="shrink-0 text-blue-600 hover:underline">
              Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Skipped - No Email" count={report.skippedNoEmail.length}>
        {report.skippedNoEmail.map((contact) => (
          <div key={contact.xeroContactId} className="flex items-center justify-between border-b py-1 text-xs last:border-0">
            <span>{contact.name}</span>
            <a href={`https://go.xero.com/Contacts/View/${contact.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-blue-600 hover:underline">
              Open in Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Skipped - Other Reasons" count={report.skippedOther.length}>
        {report.skippedOther.map((contact, index) => (
          <div key={`${contact.name}-${index}`} className="flex items-center justify-between border-b py-1 text-xs last:border-0">
            <div>
              <span className="font-medium">{contact.name}</span>
              <span className="ml-1 text-slate-500">- {contact.reason}</span>
            </div>
            {contact.xeroContactId ? (
              <a href={`https://go.xero.com/Contacts/View/${contact.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-blue-600 hover:underline">
                Xero
              </a>
            ) : null}
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Errors" count={report.errors.length} defaultOpen>
        {report.errors.map((error, index) => (
          <div key={`${error.name}-${index}`} className="flex items-center justify-between border-b py-1 text-xs text-red-700 last:border-0">
            <div>
              <span className="font-medium">{error.name}</span>
              <span className="ml-1">- {error.error}</span>
            </div>
            {error.xeroContactId ? (
              <a href={`https://go.xero.com/Contacts/View/${error.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-blue-600 hover:underline">
                Xero
              </a>
            ) : null}
          </div>
        ))}
      </SyncReportSection>
      <SyncReportSection title="Newly Created Members" count={report.created.length}>
        {report.created.map((contact) => (
          <div key={contact.xeroContactId} className="flex items-center justify-between border-b py-1 text-xs last:border-0">
            <div>
              <span className="font-medium">{contact.name}</span>
              <span className="ml-1 text-slate-500">{contact.email}</span>
              {contact.group ? <Badge variant="secondary" className="ml-1 py-0 text-[10px]">{contact.group}</Badge> : null}
            </div>
            <a href={`https://go.xero.com/Contacts/View/${contact.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="ml-2 shrink-0 text-blue-600 hover:underline">
              Xero
            </a>
          </div>
        ))}
      </SyncReportSection>
    </div>
  )
}
