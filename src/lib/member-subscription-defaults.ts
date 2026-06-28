import type { Role } from "@prisma/client";
import { getSeasonYear } from "@/lib/utils";

// Roles whose accounts never owe a membership subscription. ADMIN and LODGE
// accounts are operational, not memberships; NON_MEMBER and SCHOOL are
// non-member booking-request records (canLogin: false). All default to
// NOT_REQUIRED wherever they are created (seed, lodge auto-create, admin member
// creation, booking-request approval).
const SUBSCRIPTION_NOT_REQUIRED_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "LODGE",
  "NON_MEMBER",
  "SCHOOL",
]);

export function roleNeverRequiresSubscription(
  role: string | null | undefined,
): boolean {
  return Boolean(role && SUBSCRIPTION_NOT_REQUIRED_ROLES.has(role));
}

// Structural client type so the helper works with PrismaClient, a transaction
// client, and the seed script alike.
interface MemberSubscriptionUpsertDb {
  memberSubscription: {
    upsert(args: {
      where: { memberId_seasonYear: { memberId: string; seasonYear: number } };
      update: Record<string, never>;
      create: { memberId: string; seasonYear: number; status: "NOT_REQUIRED" };
    }): Promise<unknown>;
  };
}

/**
 * Create-if-missing a NOT_REQUIRED subscription row for the current season
 * when the member's role never owes a subscription. Never overwrites an
 * existing row, so re-runs are no-ops.
 */
export async function ensureNotRequiredSubscriptionForRole(
  db: MemberSubscriptionUpsertDb,
  member: { id: string; role: Role },
  seasonYear: number = getSeasonYear()
): Promise<void> {
  if (!roleNeverRequiresSubscription(member.role)) {
    return;
  }

  await db.memberSubscription.upsert({
    where: { memberId_seasonYear: { memberId: member.id, seasonYear } },
    update: {},
    create: { memberId: member.id, seasonYear, status: "NOT_REQUIRED" },
  });
}
