/**
 * Column model for the public `{{hut-fees}}` embed (#2129).
 *
 * The embed used to read the member/non-member `SeasonRate` table (since
 * dropped by #2129 step 2) and
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

/**
 * Fold a flat type's (`ageGroupsApply=false`) rows down to the single price it
 * publishes. The canonical shape is exactly one NULL-tier row, but a type
 * flipped to flat while per-tier rows survive can carry several.
 *
 * This choice must be TOTAL and independent of row order. "First row wins" was
 * neither: callers hand us rows straight from Prisma's `orderBy ageTier asc`,
 * and Postgres sorts a native enum by DECLARATION order — `AgeTier` declares
 * INFANT first and Prisma puts NULLs LAST. So the cheapest tier tended to win
 * and the genuine flat row tended to lose. A type carrying stray INFANT 0 /
 * ADULT 9000 rows would publish "All ages — $0.00": the club advertising free
 * accommodation on its public website.
 *
 * Resolution order:
 *   1. A real NULL-tier row is authoritative — that is the flat rate itself.
 *   2. Otherwise the data is malformed and any answer is a guess, so guess in
 *      the safe direction: the HIGHEST price. Over-quoting is recoverable at
 *      the desk; under-quoting (worst case, free) is publicly binding-looking
 *      and unrecoverable.
 *   3. Ties are impossible to distinguish by price, so they resolve on tier
 *      name to stay deterministic across renders.
 */
function flatPrice(rates: HutFeeColumnType["rates"]): number | undefined {
  const flat = rates.find((rate) => rate.ageTier === null);
  if (flat) return flat.pricePerNightCents;
  let chosen: { ageTier: string | null; pricePerNightCents: number } | undefined;
  for (const rate of rates) {
    if (
      !chosen ||
      rate.pricePerNightCents > chosen.pricePerNightCents ||
      (rate.pricePerNightCents === chosen.pricePerNightCents &&
        (rate.ageTier ?? "").localeCompare(chosen.ageTier ?? "") < 0)
    ) {
      chosen = rate;
    }
  }
  return chosen?.pricePerNightCents;
}

function priceMap(type: HutFeeColumnType): Map<string | null, number> {
  const prices = new Map<string | null, number>();
  if (!type.ageGroupsApply) {
    const cents = flatPrice(type.rates);
    // `cents` may legitimately be 0 — a free flat rate — so test for undefined,
    // never truthiness, or a genuinely free type would lose its column.
    if (cents !== undefined) prices.set(null, cents);
    return prices;
  }
  for (const rate of type.rates) {
    // Age-keyed types have a unique (type, tier) row per the DB constraint, so
    // there is nothing to fold here; a duplicate would be a broken invariant.
    if (!prices.has(rate.ageTier)) prices.set(rate.ageTier, rate.pricePerNightCents);
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
  const ordered = [...bySignature.entries()].map(([signature, group]) => {
    const members = group.members
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const typeNames = members.map((member) => member.name);
    return {
      signature,
      column: {
        heading: typeNames.join(", "),
        typeNames,
        sortOrder: Math.min(...members.map((member) => member.sortOrder)),
        prices: group.prices,
      } satisfies HutFeeColumn,
    };
  });
  // `MembershipType.name` is not unique (only `key` is), so two publicly listed
  // types can share a sortOrder AND a heading — "Senior" at two different
  // prices. localeCompare then returns 0 and the order fell back to Map
  // insertion order, which can swap between renders. The price signature is the
  // last discriminator that always differs here: two groups with the same
  // signature would already have collapsed into one column.
  ordered.sort(
    (a, b) =>
      a.column.sortOrder - b.column.sortOrder ||
      a.column.heading.localeCompare(b.column.heading) ||
      a.signature.localeCompare(b.signature),
  );
  return ordered.map((entry) => entry.column);
}
