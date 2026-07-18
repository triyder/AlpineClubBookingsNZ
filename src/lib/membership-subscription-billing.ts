import { createHash } from "node:crypto";
import type {
  MembershipFeeBillingBasis,
  MembershipFeeProrationRule,
  MembershipSubscriptionChargeSource,
  Prisma,
} from "@prisma/client";
import {
  computeAgeTierWithSettings,
  getAgeTierSettings,
  getSeasonStartDate,
  type AgeTierSettingData,
} from "@/lib/age-tier";
import { createAuditLog } from "@/lib/audit";
import { getEffectiveMembershipAnnualFee, getFamilyBillingMode } from "@/lib/authoritative-fees";
import { formatDateOnly, getTodayDateOnly, parseDateOnly } from "@/lib/date-only";
import { getSeasonStartMonth } from "@/lib/financial-year";
import { requiresPaidSubscriptionForAgeTier } from "@/lib/member-subscription-eligibility";
import { prisma } from "@/lib/prisma";
import { defaultMembershipTypeKeyForRole } from "@/lib/membership-types";
import { getResolvedAccountMapping } from "@/lib/xero-mappings";
import { XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { buildXeroIdempotencyKey, startXeroSyncOperation } from "@/lib/xero-sync";

export class SubscriptionBillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionBillingError";
  }
}

export type SubscriptionBillingExceptionCode =
  | "MISSING_MEMBERSHIP_ASSIGNMENT"
  | "MISSING_FEE_SCHEDULE"
  | "MISSING_FAMILY"
  | "AMBIGUOUS_FAMILY"
  | "INVALID_BILLING_FAMILY_SELECTION"
  | "MISSING_FAMILY_RECIPIENT"
  | "INVALID_FAMILY_RECIPIENT"
  | "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE"
  | "MISSING_XERO_ACCOUNT_MAPPING"
  | "FAMILY_ALREADY_BILLED";

// One resolved invoice line of an annual fee (#1932, E6). `xeroAccountCode` /
// `xeroItemCode` carry the per-component override if set, otherwise null until the
// post-loop mapping pass fills them from the frozen subscriptionIncome mapping.
// The frozen charge-component snapshot is written verbatim from this at confirm.
export type SubscriptionBillingComponent = {
  label: string;
  description: string;
  annualAmountCents: number;
  chargedAmountCents: number;
  prorated: boolean;
  xeroAccountCode: string | null;
  xeroItemCode: string | null;
  sortOrder: number;
};

export type SubscriptionBillingPlanEntry = {
  key: string;
  seasonYear: number;
  membershipAnnualFeeId: string;
  membershipTypeId: string;
  membershipTypeKey: string;
  membershipTypeName: string;
  billingBasis: MembershipFeeBillingBasis;
  prorationRule: MembershipFeeProrationRule;
  annualAmountCents: number;
  chargedAmountCents: number;
  coveredMonths: number;
  decisionDate: string;
  coverageStart: string;
  coverageEnd: string;
  familyGroupId: string | null;
  recipient: { id: string; name: string; email: string };
  coveredMembers: Array<{ id: string; name: string }>;
  xeroAccountCode: string | null;
  xeroItemCode: string | null;
  components: SubscriptionBillingComponent[];
};

export type SubscriptionBillingPlanException = {
  fingerprint: string;
  code: SubscriptionBillingExceptionCode;
  message: string;
  seasonYear: number;
  memberId: string | null;
  familyGroupId: string | null;
  membershipTypeId: string | null;
  context: Record<string, unknown>;
};

export type SubscriptionBillingPreview = {
  seasonYear: number;
  decisionDate: string;
  dueDays: number;
  scopeMemberIds: string[] | null;
  entries: SubscriptionBillingPlanEntry[];
  exceptions: SubscriptionBillingPlanException[];
  alreadyCoveredMemberIds: string[];
  // Members skipped by a BASED_ON_AGE_TIER type because their season-start age
  // tier does not require a subscription (issue #2041). They mint no charge and
  // no Xero op; confirm upserts a NOT_REQUIRED MemberSubscription row for them
  // so their booking status stays consistent with billing (decision Q4). Not
  // part of the confirmation token — the set is derived deterministically from
  // members, age-tier settings, and per-type fees, so the in-transaction
  // re-preview reproduces it, and clubs with no BASED_ON_AGE_TIER type keep a
  // byte-identical token (always []).
  exemptMemberIds: string[];
  totalCents: number;
  confirmationToken: string;
};

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function seasonBounds(seasonYear: number) {
  const startMonth = getSeasonStartMonth();
  const start = new Date(Date.UTC(seasonYear, startMonth - 1, 1));
  const nextStart = new Date(Date.UTC(seasonYear + 1, startMonth - 1, 1));
  const end = new Date(nextStart.getTime() - 24 * 60 * 60 * 1000);
  return { start, end };
}

export function calculateMembershipCharge(input: {
  annualAmountCents: number;
  prorationRule: MembershipFeeProrationRule;
  seasonYear: number;
  decisionDate: Date;
}) {
  if (!Number.isSafeInteger(input.annualAmountCents) || input.annualAmountCents < 0) {
    throw new SubscriptionBillingError("Annual membership fee must be a non-negative integer number of cents.");
  }
  const { start, end } = seasonBounds(input.seasonYear);
  const decision = new Date(Date.UTC(
    input.decisionDate.getUTCFullYear(),
    input.decisionDate.getUTCMonth(),
    input.decisionDate.getUTCDate(),
  ));
  if (decision < start || decision > end) {
    throw new SubscriptionBillingError(`Decision date must fall within membership year ${input.seasonYear}.`);
  }
  if (input.prorationRule === "NONE") {
    return {
      amountCents: input.annualAmountCents,
      coveredMonths: 12,
      coverageStart: start,
      coverageEnd: end,
    };
  }
  const coveredMonths =
    (end.getUTCFullYear() - decision.getUTCFullYear()) * 12 +
    end.getUTCMonth() - decision.getUTCMonth() + 1;
  return {
    // Integer arithmetic with half-up cent rounding. Values are far below the
    // JS safe-integer ceiling because fee schedules are constrained to Int32.
    amountCents: Math.floor((input.annualAmountCents * coveredMonths + 6) / 12),
    coveredMonths,
    coverageStart: new Date(Date.UTC(decision.getUTCFullYear(), decision.getUTCMonth(), 1)),
    coverageEnd: end,
  };
}

// The historical single-line invoice description. A single-component fee (every
// existing fee post-backfill) reproduces this EXACT text — including the
// `(1 month)` vs `(N months)` pluralization — so a backfilled legacy charge
// re-driven through the outbox mints a byte-identical line. Multi-component fees
// append the component label to distinguish their lines.
export function buildComponentLineDescription(input: {
  membershipTypeName: string;
  seasonYear: number;
  coveredMonths: number;
  label: string;
  isSoleComponent: boolean;
}) {
  const base = `${input.membershipTypeName} membership ${input.seasonYear}/${input.seasonYear + 1}`
    + ` (${input.coveredMonths} month${input.coveredMonths === 1 ? "" : "s"})`;
  return input.isSoleComponent ? base : `${base} — ${input.label}`;
}

// Per-component charged cents: same half-up cent rounding as the fee-level
// calculation, applied per line. Σ of per-component floors can diverge from the
// fee-level floor by up to (n−1) cents for a multi-component prorated fee — this
// is intended: the charge total is authoritative as Σ components so the invoice
// (one line per component) always foots to the charge amount (see
// docs/AUTHORITATIVE_FEES.md). A single-component fee is byte-identical.
function componentChargedCents(amountCents: number, prorate: boolean, coveredMonths: number) {
  return prorate ? Math.floor((amountCents * coveredMonths + 6) / 12) : amountCents;
}

function exception(input: Omit<SubscriptionBillingPlanException, "fingerprint">) {
  return { ...input, fingerprint: digest([input.seasonYear, input.code, input.memberId, input.familyGroupId, input.membershipTypeId]) };
}

export async function getSubscriptionBillingDueDays(tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const row = await tx.membershipSubscriptionBillingSettings.findUnique({
    where: { id: "default" },
    select: { invoiceDueDays: true },
  });
  return row?.invoiceDueDays ?? 30;
}

export async function buildSubscriptionBillingPreview(input: {
  seasonYear: number;
  decisionDate?: Date;
  memberIds?: string[];
  store?: Prisma.TransactionClient | typeof prisma;
}): Promise<SubscriptionBillingPreview> {
  const db = input.store ?? prisma;
  const decisionDate = input.decisionDate ?? getTodayDateOnly();
  // Validate the date against the selected membership year before querying,
  // including an otherwise-empty preview.
  const bounds = seasonBounds(input.seasonYear);
  if (decisionDate < bounds.start || decisionDate > bounds.end) {
    throw new SubscriptionBillingError(`Decision date must fall within membership year ${input.seasonYear}.`);
  }
  const [dueDays, familyBillingMode, alreadyCovered, alreadyPaid, existingFamilyCharges, members] = await Promise.all([
    getSubscriptionBillingDueDays(db),
    getFamilyBillingMode(db),
    db.membershipSubscriptionChargeCoverage.findMany({
      where: {
        subscription: {
          seasonYear: input.seasonYear,
          ...(input.memberIds?.length ? { memberId: { in: input.memberIds } } : {}),
        },
      },
      select: { memberId: true },
    }),
    // #1944 non-clobber guard: the sweep otherwise keys "already handled" off
    // charge-coverage rows, so a manually marked-paid subscription (status PAID
    // with no charge and no Xero invoice link) would be re-invoiced. Skip every
    // member whose subscription is already PAID for this season. Xero-paid rows
    // already carry a coverage row and are a no-op here; this strictly adds the
    // manual-PAID case and upholds "never invoice a subscription already PAID".
    db.memberSubscription.findMany({
      where: {
        seasonYear: input.seasonYear,
        status: "PAID",
        ...(input.memberIds?.length ? { memberId: { in: input.memberIds } } : {}),
      },
      select: { memberId: true },
    }),
    db.membershipSubscriptionCharge.findMany({
      where: {
        seasonYear: input.seasonYear,
        billingBasis: "PER_FAMILY",
        familyGroupId: { not: null },
      },
      select: {
        id: true,
        familyGroupId: true,
        membershipTypeId: true,
      },
    }),
    db.member.findMany({
      where: {
        active: true,
        archivedAt: null,
        ...(input.memberIds?.length ? { id: { in: input.memberIds } } : {}),
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
        // #2041: DOB drives the season-start age tier for BASED_ON_AGE_TIER
        // liability; ageTier is the fail-closed fallback when DOB is unknown.
        dateOfBirth: true,
        ageTier: true,
        billingFamilyGroupId: true,
        seasonalMembershipAssignments: {
          where: { seasonYear: input.seasonYear },
          take: 1,
          select: {
            membershipType: {
              select: {
                id: true,
                key: true,
                name: true,
                subscriptionBehavior: true,
              },
            },
          },
        },
        familyGroupMemberships: {
          select: {
            familyGroupId: true,
            familyGroup: {
              select: {
                billingMembership: {
                  select: {
                    familyGroupId: true,
                    member: {
                      select: { id: true, firstName: true, lastName: true, email: true, active: true, archivedAt: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  const fallbackKeys = [...new Set(members
    .filter((member) => member.seasonalMembershipAssignments.length === 0)
    .map((member) => defaultMembershipTypeKeyForRole(member.role)))];
  const fallbackTypes = fallbackKeys.length > 0
    ? await db.membershipType.findMany({
        where: { key: { in: fallbackKeys }, isActive: true },
        select: {
          id: true, key: true, name: true, subscriptionBehavior: true,
        },
      })
    : [];
  const fallbackTypeByKey = new Map(fallbackTypes.map((type) => [type.key, type]));

  const coveredSet = new Set(alreadyCovered.map((row) => row.memberId));
  // #1944: members already PAID (manual or Xero) are never re-invoiced.
  const paidSet = new Set(alreadyPaid.map((row) => row.memberId));
  // The effective fee depends only on the membership type and the decision
  // date, and the decision date is fixed for the whole preview, so memoize
  // per membership type instead of querying once per member (#1886).
  const feeByMembershipTypeId = new Map<
    string,
    Awaited<ReturnType<typeof getEffectiveMembershipAnnualFee>>
  >();
  const getMemoizedFee = async (membershipTypeId: string) => {
    if (!feeByMembershipTypeId.has(membershipTypeId)) {
      feeByMembershipTypeId.set(
        membershipTypeId,
        await getEffectiveMembershipAnnualFee(membershipTypeId, decisionDate, db),
      );
    }
    return feeByMembershipTypeId.get(membershipTypeId) ?? null;
  };
  const billedFamilyTypes = new Map(existingFamilyCharges.map((charge) => [
    `${input.seasonYear}:${charge.membershipTypeId}:family:${charge.familyGroupId}`,
    charge.id,
  ]));
  const entries: SubscriptionBillingPlanEntry[] = [];
  const exceptions: SubscriptionBillingPlanException[] = [];
  const familyGroups = new Map<string, SubscriptionBillingPlanEntry>();
  const decisionDateOnly = formatDateOnly(decisionDate);
  // #2041: members skipped because a BASED_ON_AGE_TIER type + their season-start
  // tier is not subscription-liable. Age-tier settings are lazy-loaded once (and
  // only when a BASED_ON_AGE_TIER type is actually encountered) so clubs without
  // the feature pay no extra read.
  const exemptMemberIds = new Set<string>();
  let ageTierSettingsCache: AgeTierSettingData[] | null = null;
  const getAgeTierSettingsMemoized = async () => {
    if (!ageTierSettingsCache) {
      ageTierSettingsCache = await getAgeTierSettings();
    }
    return ageTierSettingsCache;
  };

  for (const member of members) {
    if (coveredSet.has(member.id) || paidSet.has(member.id)) continue;
    const assignment = member.seasonalMembershipAssignments[0];
    const membershipType = assignment?.membershipType
      ?? fallbackTypeByKey.get(defaultMembershipTypeKeyForRole(member.role));
    const memberName = `${member.firstName} ${member.lastName}`.trim();
    if (!membershipType) {
      exceptions.push(exception({
        code: "MISSING_MEMBERSHIP_ASSIGNMENT",
        message: `${memberName} has no membership type for ${input.seasonYear}.`,
        seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null, membershipTypeId: null,
        context: { memberName },
      }));
      continue;
    }
    if (membershipType.subscriptionBehavior === "NOT_REQUIRED") continue;
    const fee = await getMemoizedFee(membershipType.id);
    if (!fee) {
      exceptions.push(exception({
        code: "MISSING_FEE_SCHEDULE",
        message: `${membershipType.name} has no effective annual fee on ${decisionDateOnly}.`,
        seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
        membershipTypeId: membershipType.id,
        context: { memberName, decisionDate: decisionDateOnly },
      }));
      continue;
    }
    // #2041: BASED_ON_AGE_TIER defers per-member liability to the season-start
    // age tier. Only PER_MEMBER fees vary by tier — a PER_FAMILY fee bills the
    // family once regardless of any exempt child (decision Q5), so it is left on
    // the unchanged family path below. NO_INVOICE fees already mint a zero
    // charge + NOT_REQUIRED row, so they need no special handling here either.
    if (
      membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
      fee.billingBasis === "PER_MEMBER"
    ) {
      const ageTierSettings = await getAgeTierSettingsMemoized();
      // Liability tier = age at the START of the club financial year (season
      // start = 1st of the FY start month), derived from DOB so mid-season
      // birthdays never change that season's liability (decision Q3; e.g.
      // youth-from-10 with an Apr-start year: a 31 Mar 10th birthday stays a
      // Child all season, a 1 Apr 10th birthday is a Youth that season).
      // Members without a DOB fall back to their stored tier (ADULT default) —
      // fail-closed / required.
      const seasonStartTier = member.dateOfBirth
        ? computeAgeTierWithSettings(
            member.dateOfBirth,
            getSeasonStartDate(input.seasonYear),
            ageTierSettings,
          )
        : member.ageTier;
      if (!requiresPaidSubscriptionForAgeTier(seasonStartTier, ageTierSettings)) {
        // Skip the charge; confirm upserts a NOT_REQUIRED season row (Q4).
        exemptMemberIds.add(member.id);
        continue;
      }
    }
    const calculated = calculateMembershipCharge({
      annualAmountCents: fee.amountCents,
      prorationRule: fee.prorationRule,
      seasonYear: input.seasonYear,
      decisionDate,
    });
    let familyGroupId: string | null = null;
    let recipient = { id: member.id, name: memberName, email: member.email };
    if (fee.billingBasis === "PER_FAMILY") {
      // Mode guard (#159): per-family billing is disallowed while the club bills
      // members individually, so a stale PER_FAMILY schedule surfaces as a
      // visible config exception instead of being silently reinterpreted as
      // per-member. This also makes the never-infer-recipient family branch
      // below (MISSING_FAMILY_RECIPIENT / INVALID_FAMILY_RECIPIENT) unreachable
      // in individual mode, upholding the invariant by construction rather than
      // by assumption.
      if (familyBillingMode === "BILL_MEMBERS_INDIVIDUALLY") {
        exceptions.push(exception({
          code: "PER_FAMILY_FEE_IN_INDIVIDUAL_MODE",
          message: `${membershipType.name} has a per-family fee but this club bills members individually. Change the fee's billing basis before invoicing.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: membershipType.id, context: { memberName },
        }));
        continue;
      }
      if (member.familyGroupMemberships.length === 0) {
        exceptions.push(exception({
          code: "MISSING_FAMILY", message: `${memberName} has a per-family fee but is not in a family.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
          membershipTypeId: membershipType.id, context: { memberName },
        }));
        continue;
      }
      // Multi-family resolution (#1932, E6). Only reached in
      // BILL_FAMILY_VIA_BILLING_MEMBER mode (the individual-mode guard above
      // already fired). A single-group member ignores the selection entirely.
      // For a multi-group member the admin-chosen billingFamilyGroupId decides:
      //   * set and still one of the member's groups -> bill that family;
      //   * set but no longer a group -> INVALID_BILLING_FAMILY_SELECTION (the
      //     removal sweep should have NULLed it; a stale pointer degrades to a
      //     visible exception, never silent misbilling);
      //   * unset -> AMBIGUOUS_FAMILY (unchanged).
      // The chosen family then flows through the SAME downstream recipient checks
      // (MISSING_FAMILY_RECIPIENT / INVALID_FAMILY_RECIPIENT) as an unambiguous
      // family — no duplicated path.
      let membership = member.familyGroupMemberships[0];
      if (member.familyGroupMemberships.length > 1) {
        if (!member.billingFamilyGroupId) {
          exceptions.push(exception({
            code: "AMBIGUOUS_FAMILY", message: `${memberName} belongs to more than one family; choose one before billing.`,
            seasonYear: input.seasonYear, memberId: member.id, familyGroupId: null,
            membershipTypeId: membershipType.id,
            context: { memberName, familyGroupIds: member.familyGroupMemberships.map((row) => row.familyGroupId) },
          }));
          continue;
        }
        const selected = member.familyGroupMemberships.find(
          (row) => row.familyGroupId === member.billingFamilyGroupId,
        );
        if (!selected) {
          exceptions.push(exception({
            code: "INVALID_BILLING_FAMILY_SELECTION",
            message: `${memberName}'s selected billing family is no longer one of their families; re-select before billing.`,
            seasonYear: input.seasonYear, memberId: member.id, familyGroupId: member.billingFamilyGroupId,
            membershipTypeId: membershipType.id,
            context: { memberName, selectedFamilyGroupId: member.billingFamilyGroupId, familyGroupIds: member.familyGroupMemberships.map((row) => row.familyGroupId) },
          }));
          continue;
        }
        membership = selected;
      }
      familyGroupId = membership.familyGroupId;
      const billing = membership.familyGroup.billingMembership;
      if (!billing) {
        exceptions.push(exception({
          code: "MISSING_FAMILY_RECIPIENT", message: `Family ${familyGroupId} has no explicit billing recipient.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId,
          membershipTypeId: membershipType.id, context: { memberName },
        }));
        continue;
      }
      if (billing.familyGroupId !== familyGroupId || !billing.member.active || billing.member.archivedAt) {
        exceptions.push(exception({
          code: "INVALID_FAMILY_RECIPIENT", message: `Family ${familyGroupId}'s billing recipient is not an active member of that family.`,
          seasonYear: input.seasonYear, memberId: member.id, familyGroupId,
          membershipTypeId: membershipType.id,
          context: { memberName, recipientMemberId: billing.member.id },
        }));
        continue;
      }
      recipient = {
        id: billing.member.id,
        name: `${billing.member.firstName} ${billing.member.lastName}`.trim(),
        email: billing.member.email,
      };
    }
    const groupingKey = fee.billingBasis === "PER_FAMILY"
      ? `${input.seasonYear}:${membershipType.id}:family:${familyGroupId}`
      : `${input.seasonYear}:${fee.id}:member:${member.id}`;
    const existingFamilyChargeId = billedFamilyTypes.get(groupingKey);
    if (existingFamilyChargeId) {
      exceptions.push(exception({
        code: "FAMILY_ALREADY_BILLED",
        message: `${memberName} joined family ${familyGroupId} after its ${membershipType.name} fee was billed. The immutable family charge was not changed and no second invoice was created.`,
        seasonYear: input.seasonYear,
        memberId: member.id,
        familyGroupId,
        membershipTypeId: membershipType.id,
        context: { memberName, existingFamilyChargeId, membershipAnnualFeeId: fee.id },
      }));
      continue;
    }
    const current = familyGroups.get(groupingKey);
    if (current) {
      current.coveredMembers.push({ id: member.id, name: memberName });
      continue;
    }
    // Component invoice lines (#1932, E6). The lifecycle invariant guarantees a
    // non-NO_INVOICE fee always has >=1 component; the synthetic default is a
    // belt-and-suspenders safety net that derives the identical single line the
    // backfill would have written, so a fee that somehow lost its components
    // still bills correctly rather than silently charging zero.
    const definedComponents = fee.components ?? [];
    const feeComponents = definedComponents.length > 0
      ? definedComponents
      : [{ label: "Annual membership fee", amountCents: fee.amountCents, prorate: true, xeroAccountCode: null as string | null, xeroItemCode: null as string | null, sortOrder: 0 }];
    const isSoleComponent = feeComponents.length === 1;
    const components: SubscriptionBillingComponent[] = fee.billingBasis === "NO_INVOICE"
      ? []
      : feeComponents.map((component) => ({
          label: component.label,
          description: buildComponentLineDescription({
            membershipTypeName: membershipType.name,
            seasonYear: input.seasonYear,
            coveredMonths: calculated.coveredMonths,
            label: component.label,
            isSoleComponent,
          }),
          annualAmountCents: component.amountCents,
          chargedAmountCents: componentChargedCents(component.amountCents, component.prorate, calculated.coveredMonths),
          prorated: component.prorate,
          xeroAccountCode: component.xeroAccountCode ?? null,
          xeroItemCode: component.xeroItemCode ?? null,
          sortOrder: component.sortOrder,
        }));
    // The charge total is Σ components (see componentChargedCents). For a
    // single-component fee this equals the fee-level calculation byte-for-byte.
    const chargedAmountCents = fee.billingBasis === "NO_INVOICE"
      ? 0
      : components.reduce((sum, component) => sum + component.chargedAmountCents, 0);
    const entry: SubscriptionBillingPlanEntry = {
      key: groupingKey,
      seasonYear: input.seasonYear,
      membershipAnnualFeeId: fee.id,
      membershipTypeId: membershipType.id,
      membershipTypeKey: membershipType.key,
      membershipTypeName: membershipType.name,
      billingBasis: fee.billingBasis,
      prorationRule: fee.prorationRule,
      annualAmountCents: fee.amountCents,
      chargedAmountCents,
      coveredMonths: calculated.coveredMonths,
      decisionDate: decisionDateOnly,
      coverageStart: formatDateOnly(calculated.coverageStart),
      coverageEnd: formatDateOnly(calculated.coverageEnd),
      familyGroupId,
      recipient,
      coveredMembers: [{ id: member.id, name: memberName }],
      xeroAccountCode: null,
      xeroItemCode: null,
      components,
    };
    familyGroups.set(groupingKey, entry);
    entries.push(entry);
  }

  for (const entry of entries) {
    entry.coveredMembers.sort((left, right) => left.id.localeCompare(right.id));
  }
  entries.sort((left, right) => left.key.localeCompare(right.key));
  const invoiceEntries = entries.filter((entry) => entry.billingBasis !== "NO_INVOICE");
  if (invoiceEntries.length > 0) {
    const mapping = await getResolvedAccountMapping("subscriptionIncome", db);
    if (!mapping.code || !mapping.codeExplicitlyConfigured) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index].billingBasis !== "NO_INVOICE") entries.splice(index, 1);
      }
      exceptions.push(exception({
        code: "MISSING_XERO_ACCOUNT_MAPPING",
        message: "The subscriptionIncome Xero account mapping must be explicitly configured before membership invoices can be queued.",
        seasonYear: input.seasonYear,
        memberId: null,
        familyGroupId: null,
        membershipTypeId: null,
        context: { affectedChargeCount: invoiceEntries.length },
      }));
    } else {
      for (const entry of invoiceEntries) {
        entry.xeroAccountCode = mapping.code;
        entry.xeroItemCode = mapping.itemCode;
        // Resolve each component's account/item: its own override wins, else the
        // frozen subscriptionIncome mapping. After this pass every invoiced
        // component carries a non-null account code, which the charge-component
        // snapshot column requires.
        for (const component of entry.components) {
          component.xeroAccountCode = component.xeroAccountCode ?? mapping.code;
          component.xeroItemCode = component.xeroItemCode ?? mapping.itemCode;
        }
      }
    }
  }
  exceptions.sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const scopeMemberIds = input.memberIds?.length ? [...new Set(input.memberIds)].sort() : null;
  const tokenPayload = { seasonYear: input.seasonYear, decisionDate: decisionDateOnly, dueDays, scopeMemberIds, entries, exceptions };
  return {
    seasonYear: input.seasonYear,
    decisionDate: decisionDateOnly,
    dueDays,
    scopeMemberIds,
    entries,
    exceptions,
    alreadyCoveredMemberIds: [...coveredSet].sort(),
    exemptMemberIds: [...exemptMemberIds].sort(),
    totalCents: entries.reduce((sum, entry) => sum + entry.chargedAmountCents, 0),
    confirmationToken: digest(tokenPayload),
  };
}

async function persistOpenExceptions(
  tx: Prisma.TransactionClient,
  source: MembershipSubscriptionChargeSource,
  exceptions: SubscriptionBillingPlanException[],
) {
  for (const item of exceptions) {
    await tx.membershipBillingException.upsert({
      where: { fingerprint: item.fingerprint },
      update: {
        source,
        status: "OPEN",
        message: item.message,
        context: item.context as Prisma.InputJsonValue,
        lastSeenAt: new Date(),
        resolvedAt: null,
      },
      create: { ...item, source, context: item.context as Prisma.InputJsonValue },
    });
  }
}

export async function confirmSubscriptionBillingPreview(input: {
  preview: SubscriptionBillingPreview;
  expectedConfirmationToken: string;
  source: MembershipSubscriptionChargeSource;
  confirmedByMemberId?: string;
}) {
  if (input.preview.confirmationToken !== input.expectedConfirmationToken) {
    throw new SubscriptionBillingError("Billing preview changed; refresh and confirm the current preview.");
  }
  const chargeIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`membership-subscription-billing:${input.preview.seasonYear}`}))`;
    const preview = await buildSubscriptionBillingPreview({
      seasonYear: input.preview.seasonYear,
      decisionDate: parseDateOnly(input.preview.decisionDate),
      memberIds: input.preview.scopeMemberIds ?? undefined,
      store: tx,
    });
    if (preview.confirmationToken !== input.expectedConfirmationToken) {
      const expectedMemberIds = [...new Set(input.preview.entries.flatMap((entry) =>
        entry.coveredMembers.map((member) => member.id)))];
      const coveredMemberIds = new Set(preview.alreadyCoveredMemberIds);
      if (expectedMemberIds.length > 0 && expectedMemberIds.every((memberId) => coveredMemberIds.has(memberId))) {
        const existing = await tx.membershipSubscriptionChargeCoverage.findMany({
          where: {
            memberId: { in: expectedMemberIds },
            subscription: { seasonYear: input.preview.seasonYear },
          },
          select: { chargeId: true },
        });
        chargeIds.push(...existing.map((row) => row.chargeId));
        return;
      }
      throw new SubscriptionBillingError("Billing preview changed; refresh and confirm the current preview.");
    }
    const currentFingerprints = preview.exceptions.map((item) => item.fingerprint);
    const scopedMemberIds = [...new Set([
      ...preview.entries.flatMap((entry) => entry.coveredMembers.map((member) => member.id)),
      ...preview.exceptions.map((item) => item.memberId).filter((id): id is string => Boolean(id)),
      ...preview.alreadyCoveredMemberIds,
    ])];
    await tx.membershipBillingException.updateMany({
      where: {
        seasonYear: preview.seasonYear,
        status: "OPEN",
        ...(input.source === "NEW_MEMBER_APPROVAL" ? {
          OR: [
            { memberId: { in: scopedMemberIds } },
            { code: "MISSING_XERO_ACCOUNT_MAPPING", memberId: null },
          ],
        } : {}),
        ...(currentFingerprints.length ? { fingerprint: { notIn: currentFingerprints } } : {}),
      },
      data: { status: "RESOLVED", resolvedAt: new Date() },
    });
    await persistOpenExceptions(tx, input.source, preview.exceptions);
    for (const entry of preview.entries) {
      const subscriptions = [];
      for (const covered of entry.coveredMembers) {
        const subscription = await tx.memberSubscription.upsert({
          where: { memberId_seasonYear: { memberId: covered.id, seasonYear: entry.seasonYear } },
          update: {},
          create: {
            memberId: covered.id,
            seasonYear: entry.seasonYear,
            status: entry.billingBasis === "NO_INVOICE" ? "NOT_REQUIRED" : "NOT_INVOICED",
          },
          select: { id: true, memberId: true },
        });
        const coveredAlready = await tx.membershipSubscriptionChargeCoverage.findUnique({
          where: { subscriptionId: subscription.id }, select: { id: true },
        });
        if (!coveredAlready) subscriptions.push({ ...subscription, memberName: covered.name });
      }
      if (subscriptions.length === 0) continue;
      const idempotencyKey = digest([entry.key, subscriptions.map((row) => row.memberId).sort(), entry.chargedAmountCents]);
      const charge = await tx.membershipSubscriptionCharge.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
          idempotencyKey,
          seasonYear: entry.seasonYear,
          source: input.source,
          status: entry.billingBasis === "NO_INVOICE" ? "NOT_REQUIRED" : "QUEUED",
          membershipAnnualFeeId: entry.membershipAnnualFeeId,
          membershipTypeId: entry.membershipTypeId,
          membershipTypeKey: entry.membershipTypeKey,
          membershipTypeName: entry.membershipTypeName,
          billingBasis: entry.billingBasis,
          prorationRule: entry.prorationRule,
          annualAmountCents: entry.annualAmountCents,
          chargedAmountCents: entry.chargedAmountCents,
          coveredMonths: entry.coveredMonths,
          decisionDate: parseDateOnly(entry.decisionDate),
          coverageStart: parseDateOnly(entry.coverageStart),
          coverageEnd: parseDateOnly(entry.coverageEnd),
          familyGroupId: entry.familyGroupId,
          recipientMemberId: entry.recipient.id,
          recipientName: entry.recipient.name,
          recipientEmail: entry.recipient.email,
          dueDays: preview.dueDays,
          xeroAccountCode: entry.xeroAccountCode,
          xeroItemCode: entry.xeroItemCode,
          invoiceReference: `MEMSUB-${idempotencyKey.slice(0, 24)}`,
          confirmedByMemberId: input.confirmedByMemberId,
          confirmedAt: new Date(),
          coverage: {
            create: subscriptions.map((row) => ({
              subscriptionId: row.id,
              memberId: row.memberId,
              memberName: row.memberName,
            })),
          },
          // Frozen per-line snapshot (#1932, E6), written in the SAME tx and
          // batched into the charge create so the 60s interactive-transaction
          // budget still covers a whole-club run. NO_INVOICE charges have no
          // components. Every invoiced component's account code was resolved in
          // the preview mapping pass, so the non-null column is satisfied.
          ...(entry.billingBasis === "NO_INVOICE" || entry.components.length === 0
            ? {}
            : {
                components: {
                  create: entry.components.map((component) => {
                    // Unmapped components are spliced out during the preview
                    // mapping pass, so this always resolves on the reachable
                    // path. Fail closed rather than mint a blank-account line if
                    // a future regression lets an unmapped component through.
                    const xeroAccountCode = component.xeroAccountCode ?? entry.xeroAccountCode;
                    if (xeroAccountCode == null) {
                      throw new Error(
                        `Annual-fee component "${component.label}" for ${entry.membershipTypeName} ` +
                          `(recipient ${entry.recipient.id}, season ${entry.seasonYear}) has no resolved ` +
                          `Xero account code; the preview mapping pass should have removed unmapped components before confirm.`,
                      );
                    }
                    return {
                      label: component.label,
                      description: component.description,
                      annualAmountCents: component.annualAmountCents,
                      chargedAmountCents: component.chargedAmountCents,
                      prorated: component.prorated,
                      xeroAccountCode,
                      xeroItemCode: component.xeroItemCode,
                      sortOrder: component.sortOrder,
                    };
                  }),
                },
              }),
        },
        select: { id: true },
      });
      chargeIds.push(charge.id);
      if (entry.billingBasis !== "NO_INVOICE") {
        const correlationKey = buildXeroIdempotencyKey("membership-charge", charge.id, "invoice-and-email", "v1");
        await startXeroSyncOperation({
          direction: "OUTBOUND",
          entityType: "INVOICE",
          operationType: "CREATE",
          localModel: "MembershipSubscriptionCharge",
          localId: charge.id,
          status: "PENDING",
          idempotencyKey: correlationKey,
          correlationKey,
          requestPayload: { queueType: XERO_OUTBOX_SUBSCRIPTION_INVOICE_TYPE, chargeId: charge.id },
          createdByMemberId: input.confirmedByMemberId ?? null,
          store: tx,
        });
      }
    }
    // #2041: give each BASED_ON_AGE_TIER tier-exempt member a NOT_REQUIRED
    // season row (decision Q4) so their booking status stays consistent with
    // billing even if the stored tier is promoted mid-season. Uses the fresh
    // in-transaction preview, so members that became PAID/covered since the
    // admin previewed are already excluded. upsert with an empty update NEVER
    // overwrites an existing row (PAID/history stays intact — history-intact
    // invariant), so re-runs are no-ops. No charge and no Xero op are created.
    for (const exemptMemberId of preview.exemptMemberIds) {
      await tx.memberSubscription.upsert({
        where: {
          memberId_seasonYear: {
            memberId: exemptMemberId,
            seasonYear: preview.seasonYear,
          },
        },
        update: {},
        create: {
          memberId: exemptMemberId,
          seasonYear: preview.seasonYear,
          status: "NOT_REQUIRED",
        },
      });
    }
    if (input.confirmedByMemberId) {
      await createAuditLog({
        action: "membership-subscription-billing.confirm",
        memberId: input.confirmedByMemberId,
        targetId: String(preview.seasonYear),
        details: JSON.stringify({
          source: input.source,
          confirmationToken: input.expectedConfirmationToken,
          chargeCount: chargeIds.length,
          exceptionCount: preview.exceptions.length,
          totalCents: preview.totalCents,
        }),
      }, tx);
    }
  }, {
    // A whole-club annual run touches every member sequentially; Prisma's
    // default 5s interactive-transaction budget aborts it with P2028 for
    // clubs of a few hundred members. Match the 60s whole-run batch
    // precedent in config-transfer/apply (#1886, F12).
    timeout: 60_000,
  });
  return { chargeIds: [...new Set(chargeIds)], exceptionCount: input.preview.exceptions.length };
}

export async function queueApprovedMembershipSubscriptionCharges(input: {
  memberIds: string[];
  approvedByMemberId: string;
  decisionDate?: Date;
}) {
  const decisionDate = input.decisionDate ?? getTodayDateOnly();
  const { getSeasonYear } = await import("@/lib/utils");
  const seasonYear = getSeasonYear(decisionDate);
  const preview = await buildSubscriptionBillingPreview({ seasonYear, decisionDate, memberIds: input.memberIds });
  const result = await confirmSubscriptionBillingPreview({
    preview,
    expectedConfirmationToken: preview.confirmationToken,
    source: "NEW_MEMBER_APPROVAL",
    confirmedByMemberId: input.approvedByMemberId,
  });
  const { enqueueMembershipSubscriptionChargeOperation } = await import("@/lib/xero-subscription-invoices");
  await Promise.all(result.chargeIds.map((chargeId) =>
    enqueueMembershipSubscriptionChargeOperation(chargeId, { createdByMemberId: input.approvedByMemberId })));
  return result;
}
