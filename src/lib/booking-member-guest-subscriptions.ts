import type { AgeTier, SubscriptionStatus } from "@prisma/client";
import { getAgeTierSettings } from "@/lib/age-tier";
import {
  isSubscriptionEnforcementActive,
  requiresPaidSubscriptionForAgeTier,
} from "@/lib/member-subscription-eligibility";
import { resolveMembershipTypePoliciesForMembers } from "@/lib/membership-type-policy";
import { getSeasonYear } from "@/lib/utils";

interface BookingGuestLike {
  isMember: boolean;
  memberId?: string | null;
}

interface BookingMemberGuestSubscriptionDb {
  memberSubscription: {
    findMany(args: {
      where: {
        memberId: { in: string[] };
        seasonYear: number;
      };
      select: {
        memberId: true;
        status: true;
        xeroOnlineInvoiceUrl: true;
        xeroInvoiceNumber: true;
      };
    }): Promise<
      Array<{
        memberId: string;
        status: SubscriptionStatus;
        xeroOnlineInvoiceUrl: string | null;
        xeroInvoiceNumber: string | null;
      }>
    >;
  };
  member: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; firstName: true; lastName: true; ageTier: true };
    }): Promise<
      Array<{ id: string; firstName: string; lastName: string; ageTier: AgeTier }>
    >;
  };
}

export interface UnpaidMemberGuestInfo {
  memberId: string;
  name: string;
  status: SubscriptionStatus;
  invoiceUrl: string | null;
  invoiceNumber: string | null;
}

export async function findUnpaidMemberGuests(
  db: BookingMemberGuestSubscriptionDb,
  params: {
    bookingMemberId: string;
    checkIn: Date;
    guests: BookingGuestLike[];
  }
): Promise<UnpaidMemberGuestInfo[]> {
  const memberGuestIds = params.guests
    .filter(
      (guest) =>
        guest.isMember &&
        guest.memberId &&
        guest.memberId !== params.bookingMemberId
    )
    .map((guest) => guest.memberId as string);

  if (memberGuestIds.length === 0) {
    return [];
  }

  // With the Xero module effectively off, subscriptions cannot be invoiced or
  // paid, so member guests are never blocked on subscription status.
  if (!(await isSubscriptionEnforcementActive())) {
    return [];
  }

  const uniqueIds = [...new Set(memberGuestIds)];
  const seasonYear = getSeasonYear(params.checkIn);
  const ageTierSettings = await getAgeTierSettings();
  const subscriptions = await db.memberSubscription.findMany({
    where: {
      memberId: { in: uniqueIds },
      seasonYear,
    },
    select: {
      memberId: true,
      status: true,
      xeroOnlineInvoiceUrl: true,
      xeroInvoiceNumber: true,
    },
  });
  const membershipTypePolicies = await resolveMembershipTypePoliciesForMembers(db, {
    memberIds: uniqueIds,
    seasonYear,
  });

  const subscriptionById = new Map(
    subscriptions.map((subscription) => [subscription.memberId, subscription])
  );
  const linkedMembers = await db.member.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, firstName: true, lastName: true, ageTier: true },
  });

  const memberById = new Map(linkedMembers.map((member) => [member.id, member]));
  const billableUnpaidMemberIds = uniqueIds.filter(
    (id) => {
      const policy = membershipTypePolicies.get(id);
      if (policy?.subscriptionBehavior === "NOT_REQUIRED") {
        return false;
      }
      const subscription = subscriptionById.get(id);
      // BASED_ON_AGE_TIER (issue #2041): a NOT_REQUIRED season row is
      // authoritative for a tier-exempt member and dominates their stored
      // ageTier, so a member who was exempt at season start stays not-billable
      // even if their stored tier is promoted mid-season (decision Q4). Scoped
      // to BASED_ON_AGE_TIER so REQUIRED types are byte-unchanged.
      if (
        policy?.subscriptionBehavior === "BASED_ON_AGE_TIER" &&
        subscription?.status === "NOT_REQUIRED"
      ) {
        return false;
      }
      // BASED_ON_AGE_TIER otherwise defers to the same per-age-tier flag as
      // REQUIRED (decision Q2), so both fall through to this age-tier check.
      return subscription?.status !== "PAID"
        && (!memberById.has(id)
          || requiresPaidSubscriptionForAgeTier(
            memberById.get(id)!.ageTier,
            ageTierSettings
          ));
    }
  );

  if (billableUnpaidMemberIds.length === 0) {
    return [];
  }

  const nameById = new Map(
    linkedMembers.map((member) => [
      member.id,
      `${member.firstName} ${member.lastName}`.trim() || member.id,
    ])
  );

  return billableUnpaidMemberIds.map((id) => {
    const subscription = subscriptionById.get(id);
    return {
      memberId: id,
      name: nameById.get(id) ?? id,
      status: subscription?.status ?? "NOT_INVOICED",
      invoiceUrl: subscription?.xeroOnlineInvoiceUrl ?? null,
      invoiceNumber: subscription?.xeroInvoiceNumber ?? null,
    };
  });
}

export async function findUnpaidMemberGuestNames(
  db: BookingMemberGuestSubscriptionDb,
  params: {
    bookingMemberId: string;
    checkIn: Date;
    guests: BookingGuestLike[];
  }
): Promise<string[]> {
  const unpaidMembers = await findUnpaidMemberGuests(db, params);
  return unpaidMembers.map((member) => member.name);
}
