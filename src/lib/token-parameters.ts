// Client-safe parser for embed-token parameters (#1933, E7).
//
// The embed matcher in src/lib/page-content-embeds.ts captures the raw text
// after the FIRST colon in `{{token:...}}` with a single `([^{}]+?)` group; the
// regex itself is UNCHANGED. This module parses THAT raw string into positional
// segments and key=value parameters, so the grammar lives in one place shared by
// the server renderer and the admin token-help validation UI. No "server-only"
// import and no server dependencies — client components import this directly.
//
// Grammar (all case-insensitive on keys):
//   - Comma-separated segments; surrounding whitespace is trimmed.
//   - Each segment is either `key=value` or a bare positional segment.
//   - A bare positional is the back-compat lodge slug for {{hut-fees:slug}}
//     (the sole exception is the literal `by-age`, an alias for group-by=age).
//   - A value may carry multiple entries joined with `+`, e.g.
//     `group-by=type+age` → ["type", "age"].
//   - Recognised keys for the fee embeds: lodge, type, age, group-by.

export type ParsedTokenParameters = {
  /** Bare segments in document order (no `=`). */
  positional: string[];
  /** key (lower-cased) → values, each `+`-separated value split out. */
  params: Map<string, string[]>;
};

/**
 * Parse the raw post-colon parameter string of an embed token. Mechanical and
 * total: malformed segments (empty, missing key) are dropped, never thrown.
 */
export function parseTokenParameters(
  raw: string | undefined | null,
): ParsedTokenParameters {
  const positional: string[] = [];
  const params = new Map<string, string[]>();
  if (!raw) return { positional, params };
  for (const rawSegment of raw.split(",")) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const eq = segment.indexOf("=");
    if (eq === -1) {
      positional.push(segment);
      continue;
    }
    const key = segment.slice(0, eq).trim().toLowerCase();
    if (!key) continue; // malformed "=value" — drop it
    const values = segment
      .slice(eq + 1)
      .split("+")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const existing = params.get(key) ?? [];
    params.set(key, [...existing, ...values]);
  }
  return { positional, params };
}

/** Grouping dimensions the fee embeds understand. */
export type FeeGroupDimension = "type" | "age";

export type ResolvedFeeTokenParameters = {
  /** Lodge slug (hut fees only): explicit `lodge=` wins over the positional. */
  lodge?: string;
  /** Public membership-type slug/key filter (`type=`). */
  type?: string;
  /** Requested grouping dimensions (`group-by=`, plus the `by-age` alias). */
  groupBy: Set<FeeGroupDimension>;
  /** Opt into the per-component annual-fee breakdown (`components`). */
  components: boolean;
};

const FEE_GROUP_DIMENSIONS = new Set<FeeGroupDimension>(["type", "age"]);

function isFeeGroupDimension(value: string): value is FeeGroupDimension {
  return FEE_GROUP_DIMENSIONS.has(value as FeeGroupDimension);
}

/**
 * Interpret parsed parameters for the three fee embeds. Unknown keys/values are
 * ignored here (they never select another group's data — the loaders enforce
 * that a `type=` must resolve to a publicly-listed type or the block renders
 * empty). The first bare positional that is not the `by-age` alias is the
 * back-compat lodge slug.
 */
export function resolveFeeTokenParameters(
  raw: string | undefined | null,
): ResolvedFeeTokenParameters {
  const { positional, params } = parseTokenParameters(raw);
  const groupBy = new Set<FeeGroupDimension>();

  for (const value of params.get("group-by") ?? []) {
    const normalized = value.toLowerCase();
    if (isFeeGroupDimension(normalized)) groupBy.add(normalized);
  }
  // `by-age` (bare positional or key form) is a shorthand for group-by=age.
  const hasFlag = (name: string) =>
    params.has(name) || positional.some((segment) => segment.toLowerCase() === name);
  if (hasFlag("by-age")) groupBy.add("age");
  const components = hasFlag("components");

  // The first bare positional that is not a recognised bare flag is the
  // back-compat lodge slug.
  const lodgePositional = positional.find((segment) => {
    const lower = segment.toLowerCase();
    return lower !== "by-age" && lower !== "components";
  });
  const lodge = params.get("lodge")?.[0] ?? lodgePositional;
  const type = params.get("type")?.[0];

  return {
    lodge: lodge?.trim() || undefined,
    type: type?.trim() || undefined,
    groupBy,
    components,
  };
}
