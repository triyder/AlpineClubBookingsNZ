import type {
  AgeTier,
  FinanceAccessLevel,
  Gender,
  Title,
} from "@prisma/client";
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card";
import type { XeroEntranceFeeInvoiceOptions } from "@/lib/admin-xero-entrance-fee";
import type { AppAccessRole } from "@/lib/access-roles";
import type { AppRole } from "@/lib/member-roles";

type MemberRole = AppRole;

export interface Member {
  id: string;
  title: Title | null;
  firstName: string;
  lastName: string;
  gender: Gender | null;
  occupation: string | null;
  email: string;
  phoneCountryCode: string | null;
  phoneAreaCode: string | null;
  phoneNumber: string | null;
  dateOfBirth: string | null;
  role: MemberRole;
  // Role tokens: enum values or AccessRoleDefinition ids.
  accessRoles: string[];
  ageTier: AgeTier;
  financeAccessLevel: FinanceAccessLevel;
  active: boolean;
  xeroContactId: string | null;
  cancelledAt: string | null;
  cancelledReason: string | null;
  lifeMemberDate: string | null;
  comments: string | null;
  archivedAt: string | null;
  archivedReason: string | null;
  xeroContactGroupsLoaded: boolean;
  xeroContactGroups: Array<{ id: string; name: string }>;
  subscriptionStatus:
    | "NOT_INVOICED"
    | "UNPAID"
    | "PAID"
    | "OVERDUE"
    | "NOT_REQUIRED"
    | null;
  subscriptionXeroInvoiceId: string | null;
  currentMembershipType: {
    id: string;
    key: string;
    name: string;
    isActive: boolean;
  } | null;
  createdAt: string;
  joinedDate: string | null;
  forcePasswordChange: boolean;
  hasCompletedAccountSetup: boolean;
  pendingInviteExpiresAt: string | null;
  canLogin: boolean;
  streetAddressLine1: string | null;
  streetAddressLine2: string | null;
  streetCity: string | null;
  streetRegion: string | null;
  streetPostalCode: string | null;
  streetCountry: string | null;
  postalAddressLine1: string | null;
  postalAddressLine2: string | null;
  postalCity: string | null;
  postalRegion: string | null;
  postalPostalCode: string | null;
  postalCountry: string | null;
  familyGroups: { id: string; name: string | null }[];
}

export interface MemberForm {
  title: Title | "";
  firstName: string;
  lastName: string;
  gender: Gender | "";
  occupation: string;
  email: string;
  phoneCountryCode: string;
  phoneAreaCode: string;
  phoneNumber: string;
  dateOfBirth: string;
  role: MemberRole;
  // Role tokens: enum values or AccessRoleDefinition ids.
  accessRoles: string[];
  ageTier: AgeTier;
  financeAccessLevel: FinanceAccessLevel;
  active: boolean;
  sendInvite: boolean;
  forcePasswordChange: boolean;
  joinedDate: string;
  lifeMemberDate: string;
  comments: string;
  canLogin: boolean;
  streetAddressLine1: string;
  streetAddressLine2: string;
  streetCity: string;
  streetRegion: string;
  streetPostalCode: string;
  streetCountry: string;
  postalAddressLine1: string;
  postalAddressLine2: string;
  postalCity: string;
  postalRegion: string;
  postalPostalCode: string;
  postalCountry: string;
}

export interface Filters {
  role: string;
  financeAccess: string;
  lifecycleStatus: string;
  membershipType: string;
  ageTier: string;
  familyGroup: string;
  inviteStatus: string;
  xeroLinked: string;
  subscription: string;
  xeroContactGroup: string;
}

export interface ImportResult {
  created: number;
  createdLoginEnabled?: number;
  createdNonLogin?: number;
  skipped: number;
  skippedRows?: Array<{ row: number; email: string; reason: string }>;
  rowNotes?: Array<{ row: number; email: string; note: string }>;
  errors: Array<{ row: number; errors: string[] }>;
  total?: number;
}

export interface PasswordActionTarget {
  label: string;
  inviteIds: string[];
  resendInviteIds: string[];
  resetIds: string[];
}

export interface XeroContactGroup {
  id: string;
  name: string;
  contactCount: number;
}

export interface XeroFeatureFlags {
  autoLoadContactGroups: boolean;
  liveMemberGroupLookups: boolean;
}

export type XeroChoice = "" | "link" | "create" | "change";

export interface PendingXeroCreateDecision {
  memberId: string;
  memberName: string;
  entranceFeeInvoiceOptions: XeroEntranceFeeInvoiceOptions;
  suggestedContacts: XeroSearchResult[];
}

export type BulkAction = "" | "deactivate" | "reactivate" | "set-role";
