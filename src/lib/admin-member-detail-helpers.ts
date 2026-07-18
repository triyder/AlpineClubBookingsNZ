import {
  shouldDefaultPostalSameAsPhysical,
  type MemberAddressValues,
} from "@/lib/member-address"
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational"

export interface AdminActor {
  id: string
  firstName: string
  lastName: string
}

export interface AuditActor {
  id: string
  firstName: string
  lastName: string
  email: string
}

export interface AuditLogEntry {
  id: string
  action: string
  details: string | null
  createdAt: string
  actor: AuditActor | null
}

export interface InviteAuditDetails {
  recipientEmail?: string
  recipientName?: string
  kind?: "invite" | "reset"
  expiryLabel?: string
}

export interface ParentLinkSummary {
  id: string
  firstName: string
  lastName: string
  email: string
  ageTier: string
  active: boolean
  canLogin: boolean
  inheritEmailFromId?: string | null
  parentLinkType: "PRIMARY" | "SECONDARY"
}

export interface PromoCodeBenefitSource {
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_NIGHTS" | "FIXED_NIGHTLY_PRICE"
  percentOff: number | null
  valueCents: number | null
  freeNightsPerIndividual: number | null
  lifetimeFreeNightsCap: number | null
  fixedNightlyPriceCents?: number | null
  fixedNightlyMode?: "SET_PRICE" | "CAP_ONLY" | null
}

export interface XeroCreateFormFields {
  firstName: string
  lastName: string
  email: string
  phoneCountryCode: string
  phoneAreaCode: string
  phoneNumber: string
  dateOfBirth: string
  joinedDate: string
  streetAddressLine1: string
  streetCity: string
  streetRegion: string
  streetPostalCode: string
  streetCountry: string
  postalAddressLine1: string
  postalCity: string
  postalRegion: string
  postalPostalCode: string
  postalCountry: string
}

// Storage keys are member-agnostic on purpose: an admin's expanded/collapsed
// choices follow them from one member page to the next. Keys retired by the
// grouped-layout redesign (subs/bookings/xero/audit) are left stale in
// localStorage; every group simply starts collapsed on first visit.
export const collapsibleMemberSections = [
  "contact",
  "account",
  "family",
  "membership",
  "finance",
  "committee",
  "history",
  "lifecycle",
] as const
export type CollapsibleMemberSection =
  (typeof collapsibleMemberSections)[number]

export const memberSectionStorageKeys: Record<
  CollapsibleMemberSection,
  string
> = {
  contact: "admin-member-section:contact",
  account: "admin-member-section:account",
  family: "admin-member-section:family",
  membership: "admin-member-section:membership",
  finance: "admin-member-section:finance",
  committee: "admin-member-section:committee",
  history: "admin-member-section:history",
  lifecycle: "admin-member-section:lifecycle",
}

export function isCollapsibleMemberSection(
  value: string
): value is CollapsibleMemberSection {
  return collapsibleMemberSections.includes(value as CollapsibleMemberSection)
}

// The label names the parent surface the back-link returns to; the shared
// BackLink prepends the ← affordance, so the label stays a bare parent name
// (no "Back to " prefix, which would duplicate the arrow — #2046).
export function getMemberDetailBackLabel(returnTo: string) {
  if (returnTo.startsWith("/admin/bookings")) return "Bookings"
  if (returnTo.startsWith("/admin/payments")) return "Payments"
  if (returnTo.startsWith("/admin/subscriptions")) return "Subscriptions"
  if (returnTo.startsWith("/admin/refund-requests")) return "Refund Requests"
  if (returnTo.startsWith("/admin/xero")) return "Xero"
  return "Members"
}

export function formatAdminName(admin: AdminActor | null | undefined) {
  return admin ? `${admin.firstName} ${admin.lastName}` : "Unknown admin"
}

export function parseInviteAuditDetails(
  details: string | null
): InviteAuditDetails | null {
  if (!details) return null

  try {
    const parsed = JSON.parse(details) as InviteAuditDetails
    if (typeof parsed !== "object" || parsed === null) return null
    return parsed
  } catch {
    return null
  }
}

export function getAuditActorDisplayName(
  actor: AuditActor | null | undefined
) {
  if (!actor) return "System"

  const fullName = `${actor.firstName} ${actor.lastName}`.trim()
  return fullName || actor.email || "System"
}

export function formatMemberAuditLogSummary(
  log: AuditLogEntry,
  formattedTimestamp: string
) {
  const parsedDetails = parseInviteAuditDetails(log.details)
  const actorName = getAuditActorDisplayName(log.actor)

  if (
    log.action === "member.setup-invite-sent" &&
    parsedDetails?.recipientEmail
  ) {
    return `Invited via email to ${parsedDetails.recipientEmail} on ${formattedTimestamp} by ${actorName}`
  }

  if (
    log.action === "member.password-reset-sent" &&
    parsedDetails?.recipientEmail
  ) {
    return `Password reset sent to ${parsedDetails.recipientEmail} on ${formattedTimestamp} by ${actorName}`
  }

  return log.action
}

export function shouldDefaultLinkSideEffects(ageTier: string) {
  return ageTier !== "ADULT"
}

export function parentLinkTypeLabel(type?: "PRIMARY" | "SECONDARY") {
  return type === "SECONDARY" ? "Second parent" : "Primary parent"
}

export function dedupeParentOptions<T extends { id: string }>(parents: T[]) {
  const seen = new Set<string>()
  return parents.filter((parent) => {
    if (seen.has(parent.id)) return false
    seen.add(parent.id)
    return true
  })
}

export function formatPromoBenefit(promo: PromoCodeBenefitSource) {
  if (promo.type === "PERCENTAGE") {
    return promo.percentOff !== null
      ? `${promo.percentOff}% off per individual`
      : "Percentage discount"
  }
  if (promo.type === "FIXED_AMOUNT") {
    return promo.valueCents !== null
      ? `$${(promo.valueCents / 100).toFixed(2)} off per individual`
      : "Fixed discount"
  }
  if (promo.type === "FIXED_NIGHTLY_PRICE") {
    if (promo.fixedNightlyPriceCents == null) {
      return "Fixed nightly price"
    }
    const mode = promo.fixedNightlyMode === "SET_PRICE" ? "set price" : "cap only"
    return `$${(promo.fixedNightlyPriceCents / 100).toFixed(2)} per eligible night · ${mode}`
  }
  if (promo.freeNightsPerIndividual !== null) {
    const perBooking = `${promo.freeNightsPerIndividual} free night${promo.freeNightsPerIndividual === 1 ? "" : "s"} per booking`
    if (promo.lifetimeFreeNightsCap != null) {
      return `${perBooking} · ${promo.lifetimeFreeNightsCap} lifetime`
    }
    return perBooking
  }
  return "Free nights"
}

export type NullableMemberAddress = Record<keyof MemberAddressValues, string | null>

export function memberUsesSamePostalAddress(member: NullableMemberAddress) {
  return shouldDefaultPostalSameAsPhysical(member)
}

export function getMissingFieldsForXeroCreate(
  form: XeroCreateFormFields
): string[] {
  const missing: string[] = []

  if (!form.firstName.trim()) missing.push("First Name")
  if (!form.lastName.trim()) missing.push("Last Name")
  if (!form.email.trim()) missing.push("Email")
  if (
    !form.phoneCountryCode.trim() ||
    !form.phoneAreaCode.trim() ||
    !form.phoneNumber.trim()
  )
    missing.push("Phone")
  if (!form.dateOfBirth) missing.push("Date of Birth")
  if (!form.joinedDate) missing.push("Joined Date")
  if (
    !form.streetAddressLine1.trim() ||
    !form.streetCity.trim() ||
    !form.streetRegion.trim() ||
    !form.streetPostalCode.trim() ||
    !form.streetCountry.trim()
  )
    missing.push("Physical Address")
  if (
    !form.postalAddressLine1.trim() ||
    !form.postalCity.trim() ||
    !form.postalRegion.trim() ||
    !form.postalPostalCode.trim() ||
    !form.postalCountry.trim()
  )
    missing.push("Postal Address")

  return missing
}

export function formatMemberDateNz(value: string) {
  return new Date(value).toLocaleDateString(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

export function formatMemberPhone(parts: {
  phoneCountryCode: string | null
  phoneAreaCode: string | null
  phoneNumber: string | null
}) {
  if (!parts.phoneNumber) return null
  return [
    parts.phoneCountryCode ? `+${parts.phoneCountryCode}` : null,
    parts.phoneAreaCode,
    parts.phoneNumber,
  ]
    .filter(Boolean)
    .join(" ")
}

// Collapsed-header preview lines for the member detail groups. Each takes the
// narrow fields it needs (not MemberDetail — _types.ts imports from this file)
// and returns a single "a · b · c" line.
const PREVIEW_SEPARATOR = " · "

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function formatMemberContactPreview(input: {
  email: string
  phoneCountryCode: string | null
  phoneAreaCode: string | null
  phoneNumber: string | null
  streetCity: string | null
}) {
  return [input.email, formatMemberPhone(input), input.streetCity]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberAccountPreview(input: {
  canLogin: boolean
  accessRoleCount: number
  active: boolean
}) {
  return [
    input.canLogin ? "Can log in" : "No login",
    input.canLogin ? pluralize(input.accessRoleCount, "role") : null,
    input.active ? "Active" : "Inactive",
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberFamilyPreview(input: {
  parentCount: number
  dependentCount: number
  familyGroupCount: number
}) {
  const parts = [
    input.parentCount > 0 ? pluralize(input.parentCount, "parent") : null,
    input.dependentCount > 0
      ? pluralize(input.dependentCount, "dependent")
      : null,
    input.familyGroupCount > 0
      ? pluralize(input.familyGroupCount, "family group")
      : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(PREVIEW_SEPARATOR) : "None"
}

export function formatMemberMembershipPreview(input: {
  currentSeasonYear: number
  currentSeasonTypeName: string | null
  currentSeasonSubscriptionLabel: string | null
}) {
  const season = `${input.currentSeasonYear}/${input.currentSeasonYear + 1}`
  return [
    `${season}: ${input.currentSeasonTypeName ?? "No seasonal type set"}`,
    input.currentSeasonSubscriptionLabel,
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberFinancePreview(input: {
  creditBalanceCents: number | null
  promoCodeCount: number
  xeroLinked: boolean
}) {
  return [
    input.creditBalanceCents === null
      ? "Credit —"
      : `Credit $${(input.creditBalanceCents / 100).toFixed(2)}`,
    input.promoCodeCount > 0
      ? pluralize(input.promoCodeCount, "promo code")
      : null,
    input.xeroLinked ? "Xero linked" : "Not linked to Xero",
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberCommitteePreview(input: {
  assignmentCount: number
}) {
  return input.assignmentCount > 0
    ? pluralize(input.assignmentCount, "assignment")
    : "None"
}

export function formatMemberHistoryPreview(input: {
  totalBookings: number
  lastStay: string | null
}) {
  return [
    pluralize(input.totalBookings, "booking"),
    input.lastStay ? `last stay ${formatMemberDateNz(input.lastStay)}` : null,
  ]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}

export function formatMemberLifecyclePreview(input: {
  active: boolean
  cancelledAt: string | null
  archivedAt: string | null
  hasPendingDeleteRequest: boolean
}) {
  const status = input.archivedAt
    ? "Archived"
    : input.cancelledAt
      ? "Cancelled"
      : input.active
        ? "Active"
        : "Inactive"
  return [status, input.hasPendingDeleteRequest ? "delete requested" : null]
    .filter(Boolean)
    .join(PREVIEW_SEPARATOR)
}
