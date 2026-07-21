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
  INFANT: "bg-pink-100 text-pink-700 border-pink-200",
  CHILD: "bg-blue-100 text-blue-700 border-blue-200",
  YOUTH: "bg-purple-100 text-purple-700 border-purple-200",
  ADULT: "bg-muted text-muted-foreground border-border",
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
  if (request.type === "CHILD_REQUEST") return "bg-blue-100 text-blue-800 border-blue-200";
  if (request.type === "ADULT_REQUEST") return "bg-violet-100 text-violet-800 border-violet-200";
  if (request.type === "REMOVAL_REQUEST") return "bg-rose-100 text-rose-800 border-rose-200";
  // GROUP_CREATE reaches its teal through the shared `--hue-*` chip tones
  // (#2137) rather than a literal Tailwind `teal-*` pair.
  if (request.type === "GROUP_CREATE") return `${CHIP_TONE_CLASSES.teal} border-hue-teal/20`;
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
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
