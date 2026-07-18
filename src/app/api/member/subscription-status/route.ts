import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireActiveSessionUser } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { getSeasonYear } from "@/lib/utils";
import { roleNeverRequiresSubscription } from "@/lib/member-subscription-defaults";
import {
  requiresPaidSubscriptionForMemberForBooking,
  resolveMembershipTypePolicyForMember,
} from "@/lib/membership-type-policy";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const inactiveResponse = await requireActiveSessionUser(session.user.id);
  if (inactiveResponse) {
    return inactiveResponse;
  }

  const seasonYear = getSeasonYear(new Date());
  const seasonDisplay = `${seasonYear}/${seasonYear + 1}`;

  const subscriptionSelect = {
    status: true,
    xeroInvoiceId: true,
    xeroInvoiceNumber: true,
    xeroOnlineInvoiceUrl: true,
  } as const;

  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: {
      role: true,
      ageTier: true,
      subscriptions: {
        where: { seasonYear },
        select: subscriptionSelect,
        take: 1,
      },
    },
  });

  const sub = member?.subscriptions[0] ?? null;
  const membershipTypePolicy = await resolveMembershipTypePolicyForMember(prisma, {
    memberId: session.user.id,
    seasonYear,
  });
  // Reports NOT_REQUIRED when the effective booking lockout does not apply:
  // operational roles, membership types that opt out, non-billable age tiers,
  // or Xero/lockout disabled. Raw invoice fields remain available below.
  const subscriptionRequired = await requiresPaidSubscriptionForMemberForBooking(prisma, {
    memberId: session.user.id,
    seasonYear,
    ageTier: member?.ageTier,
  });
  const status = sub?.status ?? "NOT_INVOICED";
  const effectiveStatus = subscriptionRequired ? status : "NOT_REQUIRED";
  const effectiveStatusReason = subscriptionRequired
    ? "REQUIRED"
    : roleNeverRequiresSubscription(member?.role ?? "USER")
      ? "ROLE_NOT_REQUIRED"
      : membershipTypePolicy?.subscriptionBehavior === "NOT_REQUIRED"
        ? "MEMBERSHIP_TYPE_NOT_REQUIRED"
        // BASED_ON_AGE_TIER (issue #2041): the type defers to the per-age-tier
        // flag; when the member's tier does not require a subscription (or a
        // NOT_REQUIRED season row dominates), report the age-tier reason so the
        // member sees "not required for your age tier" rather than the generic
        // lockout-disabled bucket.
        : membershipTypePolicy?.subscriptionBehavior === "BASED_ON_AGE_TIER"
          ? "MEMBERSHIP_TYPE_AGE_TIER_NOT_REQUIRED"
          : "LOCKOUT_DISABLED_OR_AGE_TIER_NOT_REQUIRED";

  return NextResponse.json({
    status: effectiveStatus,
    rawStatus: status,
    subscriptionRequired,
    effectiveStatusReason,
    seasonDisplay,
    invoiceUrl: subscriptionRequired ? sub?.xeroOnlineInvoiceUrl ?? null : null,
    invoiceNumber: subscriptionRequired ? sub?.xeroInvoiceNumber ?? null : null,
    rawInvoiceUrl: sub?.xeroOnlineInvoiceUrl ?? null,
    rawInvoiceNumber: sub?.xeroInvoiceNumber ?? null,
    membershipTypeKey: membershipTypePolicy?.membershipType.key ?? null,
    membershipTypeName: membershipTypePolicy?.membershipType.name ?? null,
    membershipTypeSubscriptionBehavior:
      membershipTypePolicy?.subscriptionBehavior ?? null,
  });
}
