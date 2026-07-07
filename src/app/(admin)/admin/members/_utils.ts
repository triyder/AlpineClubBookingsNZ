import type { Filters, MemberForm } from "./_types";
import { ACCESS_ROLE_LABELS } from "@/lib/access-roles";
import { ROLE_LABELS } from "@/lib/member-roles";
import { LOGIN_STAGE_LABELS } from "@/lib/member-login-stage";
import { UNASSIGNED_MEMBERSHIP_TYPE_VALUE } from "@/lib/membership-type-filter";

export const emptyForm: MemberForm = {
  title: "",
  firstName: "",
  lastName: "",
  gender: "",
  email: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  dateOfBirth: "",
  role: "USER",
  accessRoles: ["USER"],
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  sendInvite: false,
  forcePasswordChange: false,
  joinedDate: "",
  lifeMemberDate: "",
  occupation: "",
  comments: "",
  canLogin: true,
  streetAddressLine1: "",
  streetAddressLine2: "",
  streetCity: "",
  streetRegion: "",
  streetPostalCode: "",
  streetCountry: "",
  postalAddressLine1: "",
  postalAddressLine2: "",
  postalCity: "",
  postalRegion: "",
  postalPostalCode: "",
  postalCountry: "",
};

export const emptyFilters: Filters = {
  role: "",
  financeAccess: "",
  lifecycleStatus: "",
  membershipType: "",
  ageTier: "",
  familyGroup: "",
  inviteStatus: "",
  xeroLinked: "",
  subscription: "",
  xeroContactGroup: "",
};

export const filterLabelMap: Record<keyof Filters, string> = {
  role: "Access Role",
  financeAccess: "Finance",
  lifecycleStatus: "Status",
  membershipType: "Membership Type",
  ageTier: "Age Tier",
  familyGroup: "Family Group",
  inviteStatus: "Login Access",
  xeroLinked: "Xero",
  subscription: "Subscription",
  xeroContactGroup: "Xero Group",
};

export const filterValueLabels: Partial<
  Record<keyof Filters, Record<string, string>>
> = {
  lifecycleStatus: {
    active: "Active",
    inactive: "Inactive",
    cancelled: "Cancelled",
    archived: "Archived",
    all: "All Including Archived",
  },
  // The `role` filter param carries either an access-role token (from the
  // Access Role select) or a non-login member-type Role (from the Non-Member
  // Category select), so cover both so the active-filter chip renders a
  // friendly label.
  role: {
    ...ACCESS_ROLE_LABELS,
    NON_MEMBER: ROLE_LABELS.NON_MEMBER,
    SCHOOL: ROLE_LABELS.SCHOOL,
  },
  // The `membershipType` param carries a DB MembershipType id (resolved to its
  // name in the toolbar via the membership-type options) or the Unassigned
  // sentinel; only the sentinel has a static friendly label here.
  membershipType: { [UNASSIGNED_MEMBERSHIP_TYPE_VALUE]: "Unassigned" },
  familyGroup: { any: "Yes", none: "No" },
  // The `inviteStatus` param carries the four mutually-exclusive login stages
  // (#1444); the three login-on values stay the historical action kinds.
  inviteStatus: {
    "no-login": LOGIN_STAGE_LABELS["no-login"],
    invite: LOGIN_STAGE_LABELS["not-invited"],
    "resend-invite": LOGIN_STAGE_LABELS.invited,
    "reset-password": LOGIN_STAGE_LABELS["can-login"],
  },
  xeroLinked: { true: "Linked", false: "Not Linked" },
  subscription: {
    PAID: "Paid",
    UNPAID: "Unpaid",
    OVERDUE: "Overdue",
    NOT_INVOICED: "Not Invoiced",
    NONE: "No Record",
    NOT_REQUIRED: "Not Required",
  },
};

export const subscriptionStatusConfig: Record<
  string,
  { className: string; label: string }
> = {
  PAID: {
    className:
      "bg-green-100 text-green-800 border-green-200 hover:bg-green-200",
    label: "Paid",
  },
  UNPAID: {
    className:
      "bg-yellow-100 text-yellow-800 border-yellow-200 hover:bg-yellow-200",
    label: "Unpaid",
  },
  OVERDUE: {
    className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-200",
    label: "Overdue",
  },
  NOT_INVOICED: {
    className:
      "bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-200",
    label: "Not Invoiced",
  },
  NONE: {
    className: "bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100",
    label: "No Record",
  },
  NOT_REQUIRED: {
    className: "bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100",
    label: "Not Required",
  },
};

/**
 * Format an AgeTier for display (e.g. "ADULT" → "Adult").
 *
 * #1440 follow-up: AgeTier will gain a NOT_APPLICABLE member for organisation /
 * no-DOB records. We map the raw string defensively here — without depending on
 * the not-yet-added enum member — so the combined Type–Tier column renders
 * "N/A" the moment #1440 lands, with no further change to this file.
 */
export function formatAgeTierLabel(ageTier: string): string {
  if (ageTier === "NOT_APPLICABLE") return "N/A";
  return ageTier.charAt(0) + ageTier.slice(1).toLowerCase();
}

/**
 * Combined "Type – Tier" display column (#1445). The membership type and age
 * tier stay separate data (separate filters); this only combines them for
 * display, e.g. "Full – Adult". Members with no current-season membership type
 * read "Unassigned – {tier}", matching the Membership Type filter's Unassigned
 * option.
 */
export function formatTypeTierLabel(
  typeName: string | null | undefined,
  ageTier: string,
): string {
  return `${typeName ?? "Unassigned"} – ${formatAgeTierLabel(ageTier)}`;
}

export function getInitialLifecycleStatus(searchParams: URLSearchParams) {
  const lifecycleStatus = searchParams.get("lifecycleStatus");
  if (lifecycleStatus) return lifecycleStatus;
  const active = searchParams.get("active");
  if (active === "true") return "active";
  if (active === "false") return "inactive";
  return "";
}

export function getMissingFieldsForXeroCreate(form: MemberForm): string[] {
  const missing: string[] = [];

  if (!form.firstName.trim()) missing.push("First Name");
  if (!form.lastName.trim()) missing.push("Last Name");
  if (!form.email.trim()) missing.push("Email");
  if (
    !form.phoneCountryCode.trim() ||
    !form.phoneAreaCode.trim() ||
    !form.phoneNumber.trim()
  ) {
    missing.push("Phone");
  }
  if (!form.dateOfBirth) missing.push("Date of Birth");
  if (!form.joinedDate) missing.push("Joined Date");
  if (
    !form.streetAddressLine1.trim() ||
    !form.streetCity.trim() ||
    !form.streetRegion.trim() ||
    !form.streetPostalCode.trim() ||
    !form.streetCountry.trim()
  ) {
    missing.push("Physical Address");
  }
  if (
    !form.postalAddressLine1.trim() ||
    !form.postalCity.trim() ||
    !form.postalRegion.trim() ||
    !form.postalPostalCode.trim() ||
    !form.postalCountry.trim()
  ) {
    missing.push("Postal Address");
  }

  return missing;
}
