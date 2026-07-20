/**
 * Column model for the public `{{hut-fees}}` embed (#2129).
 *
 * The embed used to read the frozen member/non-member `SeasonRate` table and
 * present two fixed audiences. It now reads the authoritative
 * `MembershipTypeSeasonRate` rows, so a season's nightly rates are a grid of
 * membership type x age tier. This module turns those rows into the *columns*
 * of that grid, using the owner's column rule:
 *
 *   1. A membership type earns a column only when it is active, publicly
 *      listed, and actually carries rate rows for the season. There is no
 *      special-casing of any type key — `publiclyListed` is the only lever.
 *   2. Types whose full (age tier -> price) map is byte-identical collapse into
 *      ONE shared column whose heading lists their names, joined with ", " in
 *      sort order. The moment one of them is repriced it splits into its own
 *      column with no code change.
 *   3. Columns are ordered by the lowest `sortOrder` among the types that share
 *      them, then by heading.
 *
 * Kept free of `server-only` and of Prisma so both the public embed
 * (`public-page-content-tokens.ts`) and the setup-readiness snapshot
 * (`setup-readiness-db.ts`, which also runs from the `setup:check` CLI) can
 * share exactly one definition of "how many rate columns would the public
 * table show".
 */

/** One publicly-listed membership type plus its rate rows for a single season. */
export interface HutFeeColumnType {
  id: string;
  name: string;
  sortOrder: number;
  /** False means the type prices from a single flat rate (NULL age tier). */
  ageGroupsApply: boolean;
  rates: ReadonlyArray<{ ageTier: string | null; pricePerNightCents: number }>;
}

/** One rendered column: the collapsed type names and their shared price map. */
export interface HutFeeColumn {
  /** Collapsed type names joined with ", " in sort order. */
  heading: string;
  /** The individual type names behind this column, in sort order. */
  typeNames: string[];
  /** Lowest `sortOrder` among the collapsed types; drives column order. */
  sortOrder: number;
  /** Age tier (NULL for a flat/all-ages rate) -> price per night in cents. */
  prices: Map<string | null, number>;
}

// A flat (NULL) tier can never collide with an AgeTier enum value, which is
// always a non-empty uppercase identifier.
const FLAT_TIER_SIGNATURE = "";

function priceMap(type: HutFeeColumnType): Map<string | null, number> {
  const prices = new Map<string | null, number>();
  for (const rate of type.rates) {
    // A type with ageGroupsApply=false prices from one flat rate; fold any
    // stray per-tier row onto the flat key (first row wins), mirroring the
    // joining-fee and annual-fee embeds.
    const tier = type.ageGroupsApply ? rate.ageTier : null;
    if (!prices.has(tier)) prices.set(tier, rate.pricePerNightCents);
  }
  return prices;
}

function priceSignature(prices: Map<string | null, number>): string {
  return JSON.stringify(
    [...prices.entries()]
      .map(([tier, cents]) => [tier ?? FLAT_TIER_SIGNATURE, cents] as const)
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

/**
 * Collapse publicly-listed membership types into the embed's rate columns.
 * Types carrying no rate rows for the season are dropped entirely (rule 1).
 */
export function collapseHutFeeColumns(
  types: ReadonlyArray<HutFeeColumnType>,
): HutFeeColumn[] {
  const bySignature = new Map<
    string,
    { members: Array<{ name: string; sortOrder: number }>; prices: Map<string | null, number> }
  >();
  for (const type of types) {
    const prices = priceMap(type);
    if (prices.size === 0) continue;
    const signature = priceSignature(prices);
    const existing = bySignature.get(signature);
    if (existing) {
      existing.members.push({ name: type.name, sortOrder: type.sortOrder });
    } else {
      bySignature.set(signature, {
        members: [{ name: type.name, sortOrder: type.sortOrder }],
        prices,
      });
    }
  }
  return [...bySignature.values()]
    .map((group) => {
      const members = group.members
        .slice()
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      const typeNames = members.map((member) => member.name);
      return {
        heading: typeNames.join(", "),
        typeNames,
        sortOrder: Math.min(...members.map((member) => member.sortOrder)),
        prices: group.prices,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.heading.localeCompare(b.heading));
}
