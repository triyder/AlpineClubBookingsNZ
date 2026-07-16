/**
 * Admin season rate editor helpers (#1930, E4).
 *
 * The /admin/seasons rate editor writes `MembershipTypeSeasonRate` rows keyed
 * by membership type + optional age tier — the authoritative pricing table.
 * The legacy boolean-keyed `SeasonRate` table is left frozen (E13 drops it).
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { bookableAgeTierEnum } from "@/lib/age-tier-schema";

// One editor rate row. `ageTier` is null for a flat type (ageGroupsApply=false)
// and set per tier otherwise. Prices are GST-inclusive integer cents.
export const membershipTypeSeasonRateInputSchema = z
  .array(
    z.object({
      membershipTypeId: z.string().min(1),
      ageTier: bookableAgeTierEnum.nullable(),
      pricePerNightCents: z.number().int().min(0),
    }),
  )
  .min(1, "Must provide at least one rate");

export type MembershipTypeSeasonRateInput = z.infer<
  typeof membershipTypeSeasonRateInputSchema
>;

type MembershipTypeReadDelegate = {
  membershipType: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; key: true; bookingBehavior: true };
    }): Promise<
      Array<{ id: string; key: string; bookingBehavior: string }>
    >;
  };
};

/**
 * A membership type may carry hut rate rows iff it prices from its own rows:
 * every `MEMBER_RATE` type, plus the built-in `NON_MEMBER` type (the non-member
 * rate holder). `NON_MEMBER_RATE` (except `NON_MEMBER`) and `BLOCK_BOOKING`
 * types carry zero own rows — the D2 invariant. Also rejects duplicate
 * (membershipTypeId, ageTier) rows. Returns an error string, or null when valid.
 */
export async function validateMembershipTypeSeasonRates(
  db: MembershipTypeReadDelegate,
  rates: MembershipTypeSeasonRateInput,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const rate of rates) {
    const key = `${rate.membershipTypeId}::${rate.ageTier ?? "FLAT"}`;
    if (seen.has(key)) {
      return "Duplicate rate for the same membership type and age tier.";
    }
    seen.add(key);
  }

  const ids = [...new Set(rates.map((rate) => rate.membershipTypeId))];
  const types = await db.membershipType.findMany({
    where: { id: { in: ids } },
    select: { id: true, key: true, bookingBehavior: true },
  });
  const byId = new Map(types.map((type) => [type.id, type]));
  for (const id of ids) {
    const type = byId.get(id);
    if (!type) {
      return `Unknown membership type: ${id}`;
    }
    const rateBearing =
      type.bookingBehavior === "MEMBER_RATE" || type.key === "NON_MEMBER";
    if (!rateBearing) {
      return `Membership type "${type.key}" does not carry its own hut rates.`;
    }
  }
  return null;
}

/**
 * Replace a season's membership-type rate rows (delete + insert) inside a
 * transaction. Leaves the frozen legacy `SeasonRate` rows untouched.
 */
export async function replaceMembershipTypeSeasonRates(
  tx: Prisma.TransactionClient,
  seasonId: string,
  rates: MembershipTypeSeasonRateInput,
): Promise<void> {
  await tx.membershipTypeSeasonRate.deleteMany({ where: { seasonId } });
  if (rates.length > 0) {
    await tx.membershipTypeSeasonRate.createMany({
      data: rates.map((rate) => ({
        seasonId,
        membershipTypeId: rate.membershipTypeId,
        ageTier: rate.ageTier,
        pricePerNightCents: rate.pricePerNightCents,
      })),
    });
  }
}
