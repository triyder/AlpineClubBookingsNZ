import { CHIP_TONE_CLASSES } from "@/lib/chip-tones";

export interface MemberOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface FamilyGroupMemberRow extends MemberOption {
  ageTier: string;
  active: boolean;
  canLogin?: boolean;
  role?: string;
  inheritEmailFromId?: string | null;
  inheritEmailFrom?: { email: string } | null;
  hasPassword?: boolean;
  effectiveEmail?: string;
}

export interface FamilyGroupSummary {
  id: string;
  name: string | null;
  createdAt: string;
  members: FamilyGroupMemberRow[];
  memberCount: number;
  inactiveCount: number;
  pendingRequests: number;
}

export interface FamilyGroupDetail {
  id: string;
  name: string | null;
  createdAt: string;
  members: FamilyGroupMemberRow[];
}

export interface ParentLinkSummary extends MemberOption {
  parentLinkType: "PRIMARY" | "SECONDARY";
}

export interface RequestMemberMatch extends MemberOption {
  ageTier: string;
  active: boolean;
  canLogin?: boolean;
  dateOfBirth: string | null;
  alreadyInGroup: boolean;
  parentLinks?: ParentLinkSummary[];
}

export interface FamilyGroupRequest {
  id: string;
  type:
    | "JOIN_REQUEST"
    | "CHILD_REQUEST"
    | "ADULT_REQUEST"
    | "REMOVAL_REQUEST"
    | "GROUP_CREATE";
  createdAt: string;
  requester: MemberOption;
  familyGroup: {
    id: string;
    name: string | null;
    members: Array<{
      id: string;
      firstName: string;
      lastName: string;
      email?: string;
      ageTier?: string;
    }>;
  };
  childFirstName?: string | null;
  childLastName?: string | null;
  childDateOfBirth?: string | null;
  requestedFirstName?: string | null;
  requestedLastName?: string | null;
  requestedDateOfBirth?: string | null;
  requestedEmail?: string | null;
  requestNotes?: string | null;
  requestedAgeTier?: string | null;
  requestedAgeTierLabel?: string | null;
  canCreateMemberFromRequest?: boolean;
  subjectMemberId?: string | null;
  subjectMember?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
    active: boolean;
  } | null;
  // For GROUP_CREATE: the partner to auto-invite on approval (if any).
  invitedMemberId?: string | null;
  invitedMember?: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier?: string;
    active?: boolean;
  } | null;
  matchingMembers: RequestMemberMatch[];
}

export interface SharedEmailCluster<T extends FamilyGroupMemberRow = FamilyGroupMemberRow> {
  email: string;
  members: T[];
}

export interface FamilyGroupRequestSearchResult extends MemberOption {
  ageTier: string;
  active: boolean;
  canLogin?: boolean;
  dateOfBirth?: string | null;
  parentLinks?: ParentLinkSummary[];
}

export const AGE_TIER_COLORS: Record<string, string> = {
  // #2188 P2 (lens MEDIUM-5): age tiers are DEMOGRAPHIC categories, so they use
  // the categorical scales (never severity scales), with ONE assignment shared
  // with the roster page's AGE_TIER_COLORS — same tier, same colour everywhere.
  INFANT: "bg-cat1-3 text-cat1-11 border-cat1-6",
  CHILD: "bg-cat2-3 text-cat2-11 border-cat2-6",
  YOUTH: "bg-cat3-3 text-cat3-11 border-cat3-6",
  ADULT: "bg-cat4-3 text-cat4-11 border-cat4-6",
};

const CHILD_REQUEST_AGE_TIERS = new Set(["INFANT", "CHILD", "YOUTH"]);

export function normalizeFamilyEmail(email: string) {
  return email.trim().toLowerCase();
}

export function formatFamilyGroupDate(value: string | null | undefined) {
  if (!value) return "Not provided";
  return new Date(value).toLocaleDateString();
}

export function getMemberName(member: Pick<MemberOption, "firstName" | "lastName">) {
  return `${member.firstName} ${member.lastName}`.trim();
}

export function buildSharedEmailClusters<T extends FamilyGroupMemberRow>(
  members: T[]
): Array<SharedEmailCluster<T>> {
  const byEmail = new Map<string, T[]>();

  for (const member of members) {
    const email = normalizeFamilyEmail(member.effectiveEmail || member.email);
    const current = byEmail.get(email) ?? [];
    current.push(member);
    byEmail.set(email, current);
  }

  return Array.from(byEmail.entries())
    .filter(([, clusterMembers]) => clusterMembers.length > 1)
    .map(([email, clusterMembers]) => ({ email, members: clusterMembers }));
}

export function dedupeParentOptions(parents: ParentLinkSummary[]) {
  const seen = new Set<string>();
  return parents.filter((parent) => {
    if (seen.has(parent.id)) return false;
    seen.add(parent.id);
    return true;
  });
}

export function getFamilyGroupRequestTypeLabel(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") return "Infant/Child/Youth Request";
  if (request.type === "ADULT_REQUEST") return "Same-email Adult Request";
  if (request.type === "REMOVAL_REQUEST") return "Removal Request";
  if (request.type === "GROUP_CREATE") return "New Family Group";
  return "Join Request";
}

export function getFamilyGroupRequestBadgeClass(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") return "bg-info-3 text-info-11 border-info-6";
  if (request.type === "ADULT_REQUEST") return "bg-cat1-3 text-cat1-11 border-cat1-6";
  if (request.type === "REMOVAL_REQUEST") return "bg-danger-3 text-danger-11 border-danger-6";
  // GROUP_CREATE reaches its teal through CHIP_TONE_CLASSES.cat6 (#2218)
  // (#2137) rather than a literal Tailwind `teal-*` pair.
  if (request.type === "GROUP_CREATE") return `${CHIP_TONE_CLASSES.cat6} border-cat6-6`;
  return "bg-success-3 text-success-11 border-success-6";
}

export function getFamilyGroupRequestSubjectName(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") {
    return [request.childFirstName, request.childLastName].filter(Boolean).join(" ");
  }
  if (request.type === "ADULT_REQUEST") {
    return [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ");
  }
  if (request.type === "REMOVAL_REQUEST" && request.subjectMember) {
    return getMemberName(request.subjectMember);
  }
  return "";
}

export function getFamilyGroupRequestSummary(request: FamilyGroupRequest) {
  if (request.type === "CHILD_REQUEST") {
    const childName = [request.childFirstName, request.childLastName].filter(Boolean).join(" ");
    return `${getMemberName(request.requester)} wants to add ${childName || "an infant/child/youth member"} to ${request.familyGroup.name || "this family group"}.`;
  }
  if (request.type === "ADULT_REQUEST") {
    const adultName = [request.requestedFirstName, request.requestedLastName].filter(Boolean).join(" ");
    return `${getMemberName(request.requester)} wants to add ${adultName || "a same-email adult"} to ${request.familyGroup.name || "this family group"}.`;
  }
  if (request.type === "REMOVAL_REQUEST") {
    const subjectName = request.subjectMember ? getMemberName(request.subjectMember) : "a member";
    return `${getMemberName(request.requester)} wants to remove ${subjectName} from ${request.familyGroup.name || "this family group"}.`;
  }
  if (request.type === "GROUP_CREATE") {
    const partnerClause = request.invitedMember
      ? ` and invite ${getMemberName(request.invitedMember)}`
      : "";
    return `${getMemberName(request.requester)} wants to create the new family group ${request.familyGroup.name || "Unnamed Group"}${partnerClause}.`;
  }
  return `${getMemberName(request.requester)} wants to join ${request.familyGroup.name || "this family group"}.`;
}

export function mergeFamilyGroupRequestCandidates(
  request: FamilyGroupRequest,
  searchedMembers: RequestMemberMatch[]
) {
  const merged = new Map<string, RequestMemberMatch>();

  for (const candidate of request.matchingMembers) {
    merged.set(candidate.id, candidate);
  }
  for (const candidate of searchedMembers) {
    merged.set(candidate.id, candidate);
  }

  return Array.from(merged.values());
}

export function mapFamilyGroupRequestSearchResults(
  request: FamilyGroupRequest,
  members: FamilyGroupRequestSearchResult[]
) {
  return members
    .filter(
      (member) =>
        request.type !== "CHILD_REQUEST" || CHILD_REQUEST_AGE_TIERS.has(member.ageTier)
    )
    .map((member) => ({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      ageTier: member.ageTier,
      active: member.active,
      canLogin: member.canLogin,
      dateOfBirth: member.dateOfBirth ?? null,
      parentLinks: member.parentLinks ?? [],
      alreadyInGroup: request.familyGroup.members.some(
        (groupMember) => groupMember.id === member.id
      ),
    }));
}

export function buildInitialRequestSelections(
  requests: FamilyGroupRequest[],
  current: Record<string, string>
) {
  const nextSelections: Record<string, string> = {};

  for (const request of requests) {
    if (current[request.id]) {
      nextSelections[request.id] = current[request.id];
      continue;
    }
    if (request.type === "CHILD_REQUEST" && request.matchingMembers.length === 1) {
      nextSelections[request.id] = request.matchingMembers[0].id;
    }
    if (
      request.type === "CHILD_REQUEST" &&
      request.matchingMembers.length === 0 &&
      request.canCreateMemberFromRequest === true
    ) {
      nextSelections[request.id] = "__create__";
    }
    if (request.type === "ADULT_REQUEST" && request.matchingMembers.length === 0) {
      nextSelections[request.id] = "__create__";
    }
  }

  return nextSelections;
}

export function buildInitialRequestNotificationParents(
  requests: FamilyGroupRequest[],
  current: Record<string, string>
) {
  const nextSelections: Record<string, string> = {};

  for (const request of requests) {
    if (request.type === "CHILD_REQUEST") {
      nextSelections[request.id] = current[request.id] ?? request.requester.id;
    }
  }

  return nextSelections;
}
