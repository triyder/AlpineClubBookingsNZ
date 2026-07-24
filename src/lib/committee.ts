import { Prisma } from "@prisma/client";

export const committeeRoleSelect = {
  id: true,
  key: true,
  name: true,
  description: true,
  contactEmail: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { assignments: true } },
} satisfies Prisma.CommitteeRoleSelect;

export const committeeAssignmentSelect = {
  id: true,
  memberId: true,
  committeeRoleId: true,
  blurb: true,
  sortOrder: true,
  published: true,
  showPhone: true,
  contactable: true,
  contactEmailMode: true,
  contactEmailOverride: true,
  isActive: true,
  assignedByMemberId: true,
  createdAt: true,
  updatedAt: true,
  committeeRole: { select: committeeRoleSelect },
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneCountryCode: true,
      phoneAreaCode: true,
      phoneNumber: true,
      role: true,
      active: true,
    },
  },
  assignedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
} satisfies Prisma.CommitteeAssignmentSelect;

export const publicCommitteeAssignmentSelect = {
  id: true,
  blurb: true,
  showPhone: true,
  contactable: true,
  committeeRole: {
    select: {
      key: true,
      name: true,
      description: true,
    },
  },
  member: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phoneCountryCode: true,
      phoneAreaCode: true,
      phoneNumber: true,
      // Member photo (MP5, #171): whether one exists and its version, for the
      // committee-roster avatar via the scoped serving endpoint.
      photoImageId: true,
      photoUpdatedAt: true,
    },
  },
} satisfies Prisma.CommitteeAssignmentSelect;

type CommitteeRoleRow = Prisma.CommitteeRoleGetPayload<{
  select: typeof committeeRoleSelect;
}>;

type CommitteeAssignmentRow = Prisma.CommitteeAssignmentGetPayload<{
  select: typeof committeeAssignmentSelect;
}>;

type PublicCommitteeAssignmentRow = Prisma.CommitteeAssignmentGetPayload<{
  select: typeof publicCommitteeAssignmentSelect;
}>;

export function committeeRoleOrderBy(): Prisma.CommitteeRoleOrderByWithRelationInput[] {
  return [{ sortOrder: "asc" }, { name: "asc" }];
}

export function committeeAssignmentOrderBy(): Prisma.CommitteeAssignmentOrderByWithRelationInput[] {
  return [
    { sortOrder: "asc" },
    { committeeRole: { sortOrder: "asc" } },
    { committeeRole: { name: "asc" } },
    { member: { lastName: "asc" } },
    { member: { firstName: "asc" } },
  ];
}

export function normalizeCommitteeText(value?: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function normalizeCommitteeEmail(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

function buildCommitteeRoleKey(name: string) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "committee-role";
}

export async function buildUniqueCommitteeRoleKey(
  db: Pick<Prisma.TransactionClient, "committeeRole">,
  name: string,
) {
  const baseKey = buildCommitteeRoleKey(name);
  let key = baseKey;
  let suffix = 2;

  while (await db.committeeRole.findUnique({ where: { key }, select: { id: true } })) {
    key = `${baseKey}-${suffix}`;
    suffix += 1;
  }

  return key;
}

function formatCommitteeMemberName(member: {
  firstName: string;
  lastName: string;
  email?: string | null;
}) {
  return `${member.firstName} ${member.lastName}`.trim() || member.email || "Member";
}

function formatCommitteeMemberPhone(member: {
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
}) {
  const parts = [
    member.phoneCountryCode,
    member.phoneAreaCode,
    member.phoneNumber,
  ].filter((part): part is string => Boolean(part?.trim()));
  return parts.length > 0 ? parts.join(" ") : null;
}

export function serializeCommitteeRole(role: CommitteeRoleRow) {
  return {
    ...role,
    assignmentCount: role._count?.assignments ?? 0,
    _count: undefined,
  };
}

export function serializeCommitteeAssignment(assignment: CommitteeAssignmentRow) {
  return {
    id: assignment.id,
    memberId: assignment.memberId,
    committeeRoleId: assignment.committeeRoleId,
    blurb: assignment.blurb,
    sortOrder: assignment.sortOrder,
    published: assignment.published,
    showPhone: assignment.showPhone,
    contactable: assignment.contactable,
    contactEmailMode: assignment.contactEmailMode,
    contactEmailOverride: assignment.contactEmailOverride,
    isActive: assignment.isActive,
    assignedByMemberId: assignment.assignedByMemberId,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
    committeeRole: serializeCommitteeRole(assignment.committeeRole),
    member: {
      ...assignment.member,
      displayName: formatCommitteeMemberName(assignment.member),
      phone: formatCommitteeMemberPhone(assignment.member),
    },
    assignedBy: assignment.assignedBy
      ? {
          ...assignment.assignedBy,
          displayName: formatCommitteeMemberName(assignment.assignedBy),
        }
      : null,
  };
}

export function serializePublicCommitteeAssignment(
  assignment: PublicCommitteeAssignmentRow,
  options: { includePhoto?: boolean } = {},
) {
  const phone = assignment.showPhone
    ? formatCommitteeMemberPhone(assignment.member)
    : null;

  // Photo metadata is emitted only when the club has opted the roster into
  // photos (committeePhotoDisplay != NONE). When disabled we expose nothing
  // about who has a photo — the field is simply absent.
  const photo =
    options.includePhoto && assignment.member.photoImageId
      ? {
          memberId: assignment.member.id,
          version: assignment.member.photoUpdatedAt
            ? assignment.member.photoUpdatedAt.toISOString()
            : null,
        }
      : null;

  return {
    id: assignment.id,
    role: assignment.committeeRole.name,
    roleKey: assignment.committeeRole.key,
    name: formatCommitteeMemberName(assignment.member),
    phone,
    contactKey: assignment.contactable ? assignment.id : null,
    description:
      normalizeCommitteeText(assignment.blurb) ??
      normalizeCommitteeText(assignment.committeeRole.description),
    photo,
  };
}
