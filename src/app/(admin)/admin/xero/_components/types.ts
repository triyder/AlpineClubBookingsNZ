import type { AgeTier } from "@prisma/client"
import type { XeroAccount, XeroItem } from "@/lib/xero-admin-cache"

export interface XeroStatus {
  connected: boolean
  tenantId: string | null
  tokenExpiresAt: string | null
}

export interface XeroReferenceCacheMeta {
  source: "memory" | "database" | "xero"
  lastRefreshedAt: string
  expiresAt: string
}

export type SectionKey =
  | "health"
  | "contactGroupMismatches"
  | "contactLinkMismatches"
  | "operations"
  | "inbound"
  | "contactSync"
  | "membershipSync"
  | "usage"
  | "mappings"
  | "setup"

export const SECTION_STORAGE_KEY = "admin-xero-section-state-v1"

export const SECTION_DEFAULTS: Record<SectionKey, boolean> = {
  health: true,
  contactGroupMismatches: false,
  contactLinkMismatches: false,
  operations: true,
  inbound: true,
  contactSync: true,
  membershipSync: true,
  usage: false,
  mappings: false,
  setup: false,
}

export interface SyncResult {
  total?: number
  matched?: number
  updated?: number
  checked?: number
  errors?: number
  errorDetails?: Array<{ member: string; error: string }>
  message?: string
  mode?: "incremental" | "backfill"
  created?: number
  createdAsDependent?: number
  createdMembers?: Array<{ name: string; email: string; xeroContactId: string; group: string }>
  createdDependents?: Array<{
    name: string
    email: string
    xeroContactId: string
    group: string
    parentMemberId: string
    parentName: string
  }>
  linkedExisting?: number
  linkedExistingDetails?: Array<{
    name: string
    email: string
    memberId: string
    xeroContactId: string
    group: string
  }>
  skippedExisting?: number
  skippedNoEmail?: number
  skippedNoEmailDetails?: Array<{ name: string; xeroContactId: string }>
  skippedArchived?: number
  skippedArchivedDetails?: Array<{
    name: string
    xeroContactId: string
    group: string
    reason?: string
  }>
  groupsProcessed?: string[]
  syncReport?: SyncReport
}

export interface SyncReport {
  created: Array<{ name: string; email: string; xeroContactId: string; group?: string }>
  updated: Array<{ name: string; memberId: string; xeroContactId: string; changes: string[] }>
  skippedNoChanges: number
  skippedNameMismatch: Array<{
    memberId: string
    memberName: string
    memberEmail: string
    xeroContactId: string
    xeroContactName: string
    xeroContactEmail: string | null
    reasons: string[]
  }>
  skippedNoEmail: Array<{ name: string; xeroContactId: string }>
  skippedOther: Array<{ name: string; xeroContactId?: string; reason: string }>
  errors: Array<{ name: string; xeroContactId?: string; error: string }>
  total: number
}

export interface ContactGroup {
  id: string
  name: string
  contactCount: number
}

export interface GroupMapping {
  groupId: string
  groupName: string
  ageTier: AgeTier | "SKIP"
}

export interface DuplicateContact {
  contactID: string
  name: string
  firstName?: string
  lastName?: string
  emailAddress: string
  hasInvoices: boolean
  invoiceCount: number
  contactStatus: string
  updatedDateUTC?: string
  xeroLink: string
  memberId?: string
  memberActive?: boolean
}

export interface DuplicateGroup {
  email: string
  contacts: DuplicateContact[]
  canCreateFamilyGroup: boolean
  eligibleMemberIds: string[]
  suggestedGroupName?: string
}

export interface DuplicateResult {
  duplicateGroups: DuplicateGroup[]
  totalContacts: number
  totalDuplicateEmails: number
  filteredByFamilyGroup: number
}

export interface ForceSyncMemberOption {
  id: string
  firstName: string
  lastName: string
  email: string
  active: boolean
  xeroContactId: string | null
}

export interface ForceSyncXeroContactOption {
  contactId: string
  name: string
  firstName: string | null
  lastName: string | null
  email: string | null
  isLinked: boolean
  linkedMemberId: string | null
  linkedMemberName: string | null
  existingMemberId: string | null
  existingMemberName: string | null
  canImportAsMember: boolean
  importBlockReason: string | null
}

export interface ForceSyncBookingOption {
  id: string
  memberName: string
  memberEmail: string
  checkIn: string
  checkOut: string
  status: string
  guestCount: number
  paymentId: string | null
  xeroInvoiceId: string | null
  canForceSyncInvoice: boolean
  forceSyncInvoiceReason: string | null
}

export interface XeroHealthSnapshot {
  unlinkedMembers: { count: number; href: string }
  failedOperations: { count: number; legacyCount: number }
  pendingOperations: { count: number }
  lastMembershipRefresh: { at: string | null; lastCronStatus: string | null; lastCronStartedAt: string | null }
  missingInvoices: { count: number }
  contactGroupMismatches: { count: number; cacheReady: boolean }
  contactLinkMismatches: { count: number; cacheReady: boolean }
  apiBudget: { status: "healthy" | "warning" | "critical" | "exhausted" | "unknown"; usagePercent: number | null; totalCalls: number | null; failedCalls: number | null }
}

export interface MissingInvoiceBooking {
  bookingId: string
  paymentId: string
  memberId: string
  memberName: string
  memberEmail: string
  status: "PAID"
  checkIn: string
  checkOut: string
  createdAt: string
  hasLinkedInvoice: boolean
}

export interface MissingInvoicesResponse {
  count: number
  bookings: MissingInvoiceBooking[]
}

export interface ConfiguredAgeTierContactGroup {
  tier: AgeTier
  label: string
  sortOrder: number
  groupId: string
  groupName: string | null
  isDefault: boolean
}

export interface ContactGroupMismatch {
  memberId: string
  memberName: string
  memberEmail: string
  ageTier: AgeTier
  xeroContactId: string
  defaultGroup: {
    id: string
    name: string | null
  } | null
  acceptedGroups: Array<{
    id: string
    name: string | null
    isDefault: boolean
  }>
  actualGroups: Array<{
    id: string
    name: string
  }>
  unexpectedManagedGroups: Array<{
    id: string
    name: string
    tier: AgeTier | null
  }>
  missingExpectedGroup: boolean
}

// Summary returned by the POST resync-from-Xero branch of the mismatch
// endpoints (#1441).
export interface ContactCacheResyncSummary {
  requestedContacts: number
  resyncedContacts: number
  removedContacts: number
  resyncedAt: string
}

export interface ContactGroupMismatchResponse {
  cacheReady: boolean
  lastRefreshedAt: string | null
  configuredMappings: ConfiguredAgeTierContactGroup[]
  count: number
  mismatches: ContactGroupMismatch[]
  resync?: ContactCacheResyncSummary
}

export interface ContactLinkMismatch {
  memberId: string
  memberName: string
  memberEmail: string
  active: boolean
  xeroContactId: string
  xeroContactName: string
  xeroContactEmail: string | null
  reasons: string[]
}

export interface ContactLinkMismatchResponse {
  cacheReady: boolean
  lastRefreshedAt: string | null
  count: number
  mismatches: ContactLinkMismatch[]
  resync?: ContactCacheResyncSummary
}

export interface XeroOperation {
  id: string
  direction: string
  entityType: string
  operationType: string
  localModel: string | null
  localId: string | null
  localUrl: string | null
  status: string
  idempotencyKey: string | null
  correlationKey: string | null
  attemptCount: number
  replayable: boolean
  lastErrorCode: string | null
  lastErrorMessage: string | null
  requestPayload: unknown
  responsePayload: unknown
  xeroObjectType: string | null
  xeroObjectId: string | null
  xeroObjectNumber: string | null
  xeroObjectUrl: string | null
  createdByMemberId: string | null
  startedAt: string | null
  completedAt: string | null
  manuallyResolvedAt: string | null
  manuallyResolvedReason: string | null
  manuallyResolvedById: string | null
  createdAt: string
  updatedAt: string
  supported: boolean
  reason: string | null
  failureState: "ACTIVE" | "REPAIRED" | "SUPERSEDED" | null
  failureStateReason: string | null
  failureRootKey: string | null
}

export interface XeroInboundEvent {
  id: string
  source: string
  eventCategory: string | null
  eventType: string
  resourceId: string | null
  eventCreatedAt: string | null
  correlationKey: string
  payload: unknown
  status: string
  errorMessage: string | null
  processedAt: string | null
  createdAt: string
  updatedAt: string
  xeroObjectUrl: string | null
  canReplay: boolean
}

export interface XeroUsageBucket {
  label: string
  count: number
  successCount: number
  failureCount: number
}

export interface XeroUsageFailure {
  id: string
  operation: string
  workflow: string | null
  resourceType: string
  rateLimitCategory: string | null
  statusCode: number | null
  errorMessage: string | null
  createdAt: string
}

export interface XeroUsageSummary {
  budget: {
    limit: number
    thresholds: Array<{
      fraction: number
      callCount: number
    }>
  }
  today: {
    usageDate: string
    totalCalls: number
    successfulCalls: number
    failedCalls: number
    dayRateLimitHits: number
    minuteRateLimitHits: number
    lastRateLimitCategory: string | null
    lastRateLimitAt: string | null
    usagePercent: number
    budgetStatus: "healthy" | "warning" | "critical" | "exhausted"
  }
  byOperation: XeroUsageBucket[]
  topWorkflows: XeroUsageBucket[]
  recentFailures: XeroUsageFailure[]
  lastDailyLimitEvent: XeroUsageFailure | null
}

export type MembershipSyncMode = "incremental" | "backfill"

export type MappingValue = {
  code: string | null
  itemCode: string | null
}

export type AccountMappings = {
  hutFeesIncome: MappingValue
  hutFeeRefunds: MappingValue
  stripeBankAccount: MappingValue
  stripeFees: MappingValue
  subscriptionIncome: MappingValue
  membershipCancellationCredit: MappingValue
  hutFeeItem: MappingValue
  hutFeeRefundItem: MappingValue
  entranceFeeItem: MappingValue
  entranceFeeAmountCents: MappingValue
}

export type HutFeeMap = Record<string, { itemCode: string }>
export type EntranceFeeMap = Record<string, { itemCode: string | null; amountCents: number | null }>

export type AccountMappingKey =
  | "hutFeesIncome"
  | "hutFeeRefunds"
  | "stripeBankAccount"
  | "stripeFees"
  | "subscriptionIncome"
  | "membershipCancellationCredit"

export type CreditItemMappingKey = "hutFeeRefundItem" | "membershipCancellationCredit"

export type { XeroAccount, XeroItem }
