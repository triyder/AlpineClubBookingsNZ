import { createHash } from "node:crypto";
import type {
  AgeTier,
  MembershipFeeBillingBasis,
  MembershipFeeProrationRule,
  MembershipSubscriptionChargeSource,
  Prisma,
  SubscriptionStatus,
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
  // #2147 (D3): members skipped because their season MemberSubscription already
  // holds a LIVE Xero invoice (xeroInvoiceId not null — PAID/UNPAID/OVERDUE).
  // The admin sees them, and their invoice number, in a collapsed "Already
  // invoiced" section instead of being silently re-billed. Derived
  // deterministically from MemberSubscription state (like alreadyCovered /
  // exempt), so it is NOT part of the confirmation token — the skip itself is
  // already reflected by the absence of an entry, which the in-transaction
  // re-preview reproduces under the per-season advisory lock.
  alreadyInvoiced: Array<{
    memberId: string;
    memberName: string;
    xeroInvoiceNumber: string | null;
    status: SubscriptionStatus;
  }>;
  // #2147 FINDING 1: family groups suppressed from a (second) PER_FAMILY charge
  // because a member of the group already holds a live season Xero invoice or an
  // active coverage claim. Surfaced beside alreadyInvoiced so the operator can
  // audit which member/invoice covers the whole family. Like alreadyInvoiced it
  // is derived deterministically from persisted state (NOT part of the
  // confirmation token — the suppressed family simply mints no entry, which the
  // in-transaction re-preview reproduces under the per-season advisory lock).
  alreadyInvoicedFamilies: Array<{
    familyGroupId: string;
    holderMemberId: string;
    holderName: string;
    xeroInvoiceNumber: string | null;
    status: SubscriptionStatus | null;
    membersCovered: number;
  }>;
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
  const [dueDays, familyBillingMode, alreadyCovered, alreadyPaid, existingFamilyCharges, familyInvoiceBlockers, members] = await Promise.all([
    getSubscriptionBillingDueDays(db),
    getFamilyBillingMode(db),
    db.membershipSubscriptionChargeCoverage.findMany({
      where: {
        // #2147: only ACTIVE claims block re-billing. A released claim (its Xero
        // invoice was voided/deleted) must not keep a member un-billable forever.
        releasedAt: null,
        subscription: {
          seasonYear: input.seasonYear,
          ...(input.memberIds?.length ? { memberId: { in: input.memberIds } } : {}),
        },
      },
      select: { memberId: true },
    }),
    // #1944 + #2147 (D1) non-clobber / anti-double-billing guard. Skip every
    // member whose season subscription is either already PAID *or* already
    // carries a LIVE Xero invoice link (xeroInvoiceId not null — UNPAID/OVERDUE
    // included). The PAID clause preserves the #1944 manual-mark-paid case
    // (PAID with a null xeroInvoiceId, cash paid outside Xero); the additive
    // xeroInvoiceId clause fixes #2147 — an invoiced-but-unpaid member (e.g.
    // billed by the older Xero-sync path, so no charge-coverage row exists) was
    // passing both the coverage and PAID guards and being re-invoiced. The
    // predicate is ADDITIVE, not a replacement: it never re-bills a manual-PAID
    // member. The invoiced subset (with its invoice number) is surfaced to the
    // admin in the collapsed "Already invoiced" section (D3).
    db.memberSubscription.findMany({
      where: {
        seasonYear: input.seasonYear,
        OR: [{ status: "PAID" }, { xeroInvoiceId: { not: null } }],
        ...(input.memberIds?.length ? { memberId: { in: input.memberIds } } : {}),
      },
      select: {
        memberId: true,
        status: true,
        xeroInvoiceId: true,
        xeroInvoiceNumber: true,
        member: { select: { firstName: true, lastName: true } },
      },
    }),
    db.membershipSubscriptionCharge.findMany({
      where: {
        seasonYear: input.seasonYear,
        billingBasis: "PER_FAMILY",
        familyGroupId: { not: null },
        // #2147: a VOIDED family charge (its Xero invoice was voided/deleted and
        // its coverage released) must NOT keep the family un-billable forever.
        // The void handler (releaseVoidedSubscriptionInvoice) retains the charge
        // row with status VOIDED + familyGroupId intact for audit; without this
        // filter it would still populate billedFamilyTypes and fire
        // FAMILY_ALREADY_BILLED, permanently blocking the family's re-bill and
        // contradicting the void→re-bill design.
        status: { not: "VOIDED" },
      },
      select: {
        id: true,
        familyGroupId: true,
        membershipTypeId: true,
      },
    }),
    // #2147 FINDING 1 (family-level dedup): every family-group membership whose
    // member already holds a LIVE season Xero invoice (xeroInvoiceId not null)
    // OR an ACTIVE coverage claim (releasedAt IS NULL). The per-member skip-set
    // (coveredSet/paidSet) only suppresses the invoice-HOLDER; a family group
    // billed PER_FAMILY would otherwise mint a SECOND family charge to the
    // recipient because a not-yet-invoiced child (no invoice link, no coverage
    // row) still proceeds through the PER_FAMILY branch and folds the whole
    // family in. Deliberately UNSCOPED by input.memberIds: a scoped
    // NEW_MEMBER_APPROVAL run for just a child must still see the billing
    // member's live invoice on the same family group. The subset is bounded by
    // the number of invoiced/covered members, so this stays cheap.
    db.familyGroupMember.findMany({
      where: {
        member: {
          subscriptions: {
            some: {
              seasonYear: input.seasonYear,
              OR: [
                { xeroInvoiceId: { not: null } },
                { chargeCoverage: { some: { releasedAt: null } } },
              ],
            },
          },
        },
      },
      select: {
        familyGroupId: true,
        memberId: true,
        member: {
          select: {
            firstName: true,
            lastName: true,
            subscriptions: {
              where: { seasonYear: input.seasonYear },
              take: 1,
              select: { xeroInvoiceId: true, xeroInvoiceNumber: true, status: true },
            },
          },
        },
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

  // #2147 FINDING 1: family groups suppressed from generating a (second) family
  // charge because at least one of their members is already billed for the
  // season. familySuppressionInfo carries the representative invoice-holder for
  // the "Already invoiced" audit surface — preferring a member who actually
  // holds a live Xero invoice (so a real invoice number is shown), then
  // deterministic by memberId so preview and the in-transaction confirm re-run
  // agree byte-for-byte.
  const suppressedFamilyGroupIds = new Set<string>();
  const familySuppressionInfo = new Map<string, {
    holderMemberId: string;
    holderName: string;
    xeroInvoiceNumber: string | null;
    status: SubscriptionStatus | null;
    hasLiveInvoice: boolean;
  }>();
  for (const row of familyInvoiceBlockers) {
    suppressedFamilyGroupIds.add(row.familyGroupId);
    const sub = row.member.subscriptions[0];
    const candidate = {
      holderMemberId: row.memberId,
      holderName: `${row.member.firstName} ${row.member.lastName}`.trim(),
      xeroInvoiceNumber: sub?.xeroInvoiceNumber ?? null,
      status: sub?.status ?? null,
      hasLiveInvoice: sub?.xeroInvoiceId != null,
    };
    const existing = familySuppressionInfo.get(row.familyGroupId);
    if (
      !existing ||
      (candidate.hasLiveInvoice && !existing.hasLiveInvoice) ||
      (candidate.hasLiveInvoice === existing.hasLiveInvoice &&
        candidate.holderMemberId < existing.holderMemberId)
    ) {
      familySuppressionInfo.set(row.familyGroupId, candidate);
    }
  }
  // Total members in each suppressed family group, so the audit line can state
  // how many members the already-live invoice covers. One cheap grouped read,
  // only when a suppression actually applies.
  const familyGroupSizeById = new Map<string, number>();
  if (suppressedFamilyGroupIds.size > 0) {
    const sizes = await db.familyGroupMember.groupBy({
      by: ["familyGroupId"],
      where: { familyGroupId: { in: [...suppressedFamilyGroupIds] } },
      _count: { memberId: true },
    });
    for (const size of sizes) familyGroupSizeById.set(size.familyGroupId, size._count.memberId);
  }
  // The suppressed family groups actually surfaced by this preview — a family is
  // only surfaced when a not-yet-billed member of it would otherwise have minted
  // a second charge (a fully-invoiced family's members are all skipped per-member
  // before the family branch, and already appear in alreadyInvoiced).
  const suppressedFamiliesSurfaced = new Set<string>();
  const alreadyInvoicedFamilies: SubscriptionBillingPreview["alreadyInvoicedFamilies"] = [];

  const coveredSet = new Set(alreadyCovered.map((row) => row.memberId));
  // #1944 + #2147: members already PAID (manual or Xero) OR holding a live Xero
  // invoice are never re-invoiced (D1). Both clauses feed one skip-set.
  const paidSet = new Set(alreadyPaid.map((row) => row.memberId));
  // #2147 (D3): the invoiced (live xeroInvoiceId) subset, for the "Already
  // invoiced" section. Names come from the joined member row so an already-
  // invoiced member who has since gone inactive still renders correctly.
  const alreadyInvoiced = alreadyPaid
    .filter((row) => row.xeroInvoiceId != null)
    .map((row) => ({
      memberId: row.memberId,
      memberName: row.member
        ? `${row.member.firstName} ${row.member.lastName}`.trim()
        : row.memberId,
      xeroInvoiceNumber: row.xeroInvoiceNumber,
      status: row.status,
    }))
    .sort((left, right) => left.memberId.localeCompare(right.memberId));
  // The effective fee depends on the membership type, the member's age tier
  // (#2067 per-tier pricing), and the decision date; the decision date is fixed
  // for the whole preview, so memoize per (type, tier) instead of querying once
  // per member (#1886). An all-flat config resolves every tier to the same flat
  // row inside the resolver, so it stays byte-identical — just keyed per tier.
  const feeByTypeAndTier = new Map<
    string,
    Awaited<ReturnType<typeof getEffectiveMembershipAnnualFee>>
  >();
  const getMemoizedFee = async (membershipTypeId: string, ageTier: AgeTier | null) => {
    const memoKey = `${membershipTypeId}:${ageTier ?? "FLAT"}`;
    if (!feeByTypeAndTier.has(memoKey)) {
      feeByTypeAndTier.set(
        memoKey,
        await getEffectiveMembershipAnnualFee({ membershipTypeId, ageTier }, decisionDate, db),
      );
    }
    return feeByTypeAndTier.get(memoKey) ?? null;
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
    // Per-tier pricing (#2067) + age-tier liability (#2041): for a
    // BASED_ON_AGE_TIER type the fee PRICE and the liability gate must both key
    // off the SAME season-start computed tier — the age at the START of the club
    // financial year (season start = 1st of the FY start month), derived from
    // DOB so mid-season birthdays never change that season's tier (decision Q3;
    // e.g. youth-from-10 with an Apr-start year: a 31 Mar 10th birthday stays a
    // Child all season, a 1 Apr 10th birthday is a Youth that season). Pricing
    // off the STORED tier while gating liability on the computed tier would
    // mis-price a member whose stored tier has drifted from the season-start
    // tier (the age-up cron only maintains the ADULT boundary, and
    // non-current-season billing recomputes) — e.g. liable as YOUTH but charged
    // the CHILD price, or overcharged at ADULT for a prior season. Members
    // without a DOB fall back to their stored tier (ADULT default) — fail-closed
    // / required. Every OTHER policy has no computed tier, so its fee resolves
    // by the member's stored tier (joining-fee convention); a NOT_APPLICABLE
    // tier still short-circuits to the flat fee inside the resolver.
    let seasonStartTier: AgeTier | null = null;
    if (membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER") {
      const ageTierSettings = await getAgeTierSettingsMemoized();
      seasonStartTier = member.dateOfBirth
        ? computeAgeTierWithSettings(
            member.dateOfBirth,
            getSeasonStartDate(input.seasonYear),
            ageTierSettings,
          )
        : member.ageTier;
    }
    // The tier ACTUALLY used to resolve the fee — also what names a
    // MISSING_FEE_SCHEDULE exception and keys the memo cache: the season-start
    // tier for a BASED_ON_AGE_TIER type, else the member's stored tier.
    const feeTier =
      membershipType.subscriptionBehavior === "BASED_ON_AGE_TIER"
        ? seasonStartTier
        : member.ageTier;
    const fee = await getMemoizedFee(membershipType.id, feeTier);
    if (!fee) {
      exceptions.push(exception({
        code: "MISSING_FEE_SCHEDULE",
        message: `${membershipType.name} has no effective annual fee for the ${feeTier} age tier on ${decisionDateOnly}.`,
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
    // #2147 FINDING 1: family-level dedup. If ANY member of this family group is
    // already billed for the season (a live Xero invoice or an active coverage
    // claim), the whole family is already covered — suppress the ENTIRE group
    // from generating a second family charge and surface it (once) in the
    // "Already invoiced" audit section, rather than minting a duplicate invoice
    // to the recipient off a not-yet-invoiced child. familyGroupId is non-null
    // only on the PER_FAMILY path, so per-member paths are untouched. Placed
    // after FAMILY_ALREADY_BILLED so an existing NEW-system family charge still
    // reports that dedicated exception; this handles the legacy shape where the
    // live invoice lives only on MemberSubscription.xeroInvoiceId with no charge
    // or coverage rows. Once the invoice is voided (link nulled, coverage
    // released) no member blocks the group and it re-bills as one normal entry.
    if (familyGroupId && suppressedFamilyGroupIds.has(familyGroupId)) {
      if (!suppressedFamiliesSurfaced.has(familyGroupId)) {
        suppressedFamiliesSurfaced.add(familyGroupId);
        const info = familySuppressionInfo.get(familyGroupId);
        if (info) {
          alreadyInvoicedFamilies.push({
            familyGroupId,
            holderMemberId: info.holderMemberId,
            holderName: info.holderName,
            xeroInvoiceNumber: info.xeroInvoiceNumber,
            status: info.status,
            membersCovered: familyGroupSizeById.get(familyGroupId) ?? 0,
          });
        }
      }
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
    alreadyInvoiced,
    alreadyInvoicedFamilies: alreadyInvoicedFamilies.sort((left, right) =>
      left.familyGroupId.localeCompare(right.familyGroupId)),
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
            // #2147: match the active-only skip-set — a released claim's chargeId
            // must not be reported as the current coverage for a re-billed member.
            releasedAt: null,
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
          // #2147: voidGeneration discriminates a post-void re-bill's idempotency
          // key from the original (released) charge's.
          select: { id: true, memberId: true, voidGeneration: true },
        });
        // #2147: only an ACTIVE coverage claim means "already billed". A released
        // claim (its invoice was voided) must NOT suppress the re-bill.
        const coveredAlready = await tx.membershipSubscriptionChargeCoverage.findFirst({
          where: { subscriptionId: subscription.id, releasedAt: null }, select: { id: true },
        });
        if (!coveredAlready) subscriptions.push({ ...subscription, memberName: covered.name });
      }
      if (subscriptions.length === 0) continue;
      // #2147: fold each covered subscription's voidGeneration into the charge
      // idempotency key so a post-void re-bill mints a NEW charge instead of
      // no-op-ing onto the released (VOIDED) one via the @unique idempotencyKey.
      // When every voidGeneration is 0 (the never-voided case) the key omits the
      // discriminator entirely, staying byte-identical to the pre-#2147 shape so
      // existing charges and re-runs remain idempotent. invoiceReference derives
      // from this key and follows automatically.
      const sortedMemberIds = subscriptions.map((row) => row.memberId).sort();
      const voidGenByMember = new Map(subscriptions.map((row) => [row.memberId, row.voidGeneration ?? 0]));
      const voidGenerations = sortedMemberIds.map((memberId) => voidGenByMember.get(memberId) ?? 0);
      const idempotencyKey = voidGenerations.some((generation) => generation > 0)
        ? digest([entry.key, sortedMemberIds, entry.chargedAmountCents, { voidGenerations }])
        : digest([entry.key, sortedMemberIds, entry.chargedAmountCents]);
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
