import { describe, expect, it } from "vitest";
import {
  collapseHutFeeColumns,
  type HutFeeColumnType,
} from "@/lib/public-hut-fee-columns";

const type = (
  overrides: Partial<HutFeeColumnType> & Pick<HutFeeColumnType, "id" | "name" | "sortOrder">,
): HutFeeColumnType => ({ ageGroupsApply: true, rates: [], ...overrides });

const headings = (types: HutFeeColumnType[]) =>
  collapseHutFeeColumns(types).map((column) => column.heading);

describe("collapseHutFeeColumns (#2129)", () => {
  it("gives each differently-priced type its own column", () => {
    expect(headings([
      type({ id: "full", name: "Full Member", sortOrder: 1, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
      type({ id: "non", name: "Non-member", sortOrder: 9, rates: [
        { ageTier: "ADULT", pricePerNightCents: 6000 },
      ] }),
    ])).toEqual(["Full Member", "Non-member"]);
  });

  it("collapses types whose full price map is identical into one column", () => {
    expect(headings([
      type({ id: "full", name: "Full Member", sortOrder: 1, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
        { ageTier: "CHILD", pricePerNightCents: 2000 },
      ] }),
      type({ id: "life", name: "Life", sortOrder: 2, rates: [
        // Same prices, rows supplied in a different order — order must not
        // affect the signature.
        { ageTier: "CHILD", pricePerNightCents: 2000 },
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
      type({ id: "family", name: "Family", sortOrder: 3, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
        { ageTier: "CHILD", pricePerNightCents: 2000 },
      ] }),
    ])).toEqual(["Full Member, Life, Family"]);
  });

  it("splits a repriced type back out of its collapsed column", () => {
    expect(headings([
      type({ id: "full", name: "Full Member", sortOrder: 1, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
      type({ id: "life", name: "Life", sortOrder: 2, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4500 },
      ] }),
      type({ id: "family", name: "Family", sortOrder: 3, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
    ])).toEqual(["Full Member, Family", "Life"]);
  });

  it("treats a partially-overlapping price map as a different column", () => {
    // Same adult price, but only one type also prices children — the maps
    // differ, so they must not share a column.
    expect(headings([
      type({ id: "full", name: "Full Member", sortOrder: 1, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
        { ageTier: "CHILD", pricePerNightCents: 2000 },
      ] }),
      type({ id: "assoc", name: "Associate", sortOrder: 2, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
    ])).toEqual(["Full Member", "Associate"]);
  });

  it("orders columns by the lowest sortOrder among the collapsed types", () => {
    const columns = collapseHutFeeColumns([
      type({ id: "non", name: "Non-member", sortOrder: 9, rates: [
        { ageTier: "ADULT", pricePerNightCents: 6000 },
      ] }),
      type({ id: "assoc", name: "Associate", sortOrder: 5, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
      type({ id: "full", name: "Full Member", sortOrder: 1, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
    ]);
    expect(columns.map((column) => column.heading)).toEqual([
      "Full Member, Associate",
      "Non-member",
    ]);
    expect(columns[0]?.sortOrder).toBe(1);
    expect(columns[0]?.typeNames).toEqual(["Full Member", "Associate"]);
  });

  it("drops types that carry no rate rows for the season", () => {
    expect(headings([
      type({ id: "full", name: "Full Member", sortOrder: 1, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
      type({ id: "block", name: "Blocked", sortOrder: 2, rates: [] }),
    ])).toEqual(["Full Member"]);
  });

  it("keys a flat type on its real NULL-tier row even when stray per-tier rows exist", () => {
    const columns = collapseHutFeeColumns([
      type({ id: "school", name: "School Group", sortOrder: 4, ageGroupsApply: false, rates: [
        { ageTier: "INFANT", pricePerNightCents: 0 },
        { ageTier: null, pricePerNightCents: 5000 },
        { ageTier: "ADULT", pricePerNightCents: 9000 },
      ] }),
    ]);
    expect(columns).toHaveLength(1);
    expect([...columns[0]!.prices.entries()]).toEqual([[null, 5000]]);
  });

  it("folds a flat type with no NULL row to its HIGHEST price, whatever the row order", () => {
    // Regression: the fold used to be "first row wins", so the result depended
    // on DB row order. Prisma sorts `ageTier asc` and Postgres sorts a native
    // enum by declaration order (INFANT first, NULLs last), so a type carrying
    // stray INFANT 0 / ADULT 9000 rows published "All ages — $0.00" and the
    // club advertised free accommodation. Both orderings must now agree, and
    // must agree on the safe direction.
    const rates = [
      { ageTier: "INFANT", pricePerNightCents: 0 },
      { ageTier: "CHILD", pricePerNightCents: 1000 },
      { ageTier: "ADULT", pricePerNightCents: 9000 },
    ];
    const dbOrder = collapseHutFeeColumns([
      type({ id: "school", name: "School Group", sortOrder: 4, ageGroupsApply: false, rates }),
    ]);
    const reversed = collapseHutFeeColumns([
      type({ id: "school", name: "School Group", sortOrder: 4, ageGroupsApply: false, rates: [...rates].reverse() }),
    ]);
    expect([...dbOrder[0]!.prices.entries()]).toEqual([[null, 9000]]);
    expect([...reversed[0]!.prices.entries()]).toEqual([[null, 9000]]);
  });

  it("keeps a genuinely free flat type rather than dropping its column", () => {
    // 0 is a real price, not "missing". A truthiness test here would drop the
    // column entirely and the type would vanish from the public table.
    const columns = collapseHutFeeColumns([
      type({ id: "child", name: "Under 5", sortOrder: 1, ageGroupsApply: false, rates: [
        { ageTier: null, pricePerNightCents: 0 },
      ] }),
    ]);
    expect(columns).toHaveLength(1);
    expect([...columns[0]!.prices.entries()]).toEqual([[null, 0]]);
  });

  it("orders identically-named, identically-sorted types deterministically", () => {
    // `MembershipType.name` is not unique, so two publicly listed "Senior"
    // types at different prices produce two columns with the same heading and
    // the same sortOrder. Order must not depend on input/Map insertion order.
    const build = (reverse: boolean) => {
      const types = [
        type({ id: "a", name: "Senior", sortOrder: 2, rates: [{ ageTier: "ADULT", pricePerNightCents: 3000 }] }),
        type({ id: "b", name: "Senior", sortOrder: 2, rates: [{ ageTier: "ADULT", pricePerNightCents: 7000 }] }),
      ];
      return collapseHutFeeColumns(reverse ? types.reverse() : types).map(
        (column) => column.prices.get("ADULT"),
      );
    };
    expect(build(false)).toEqual(build(true));
  });

  it("does not collapse a flat type with a per-tier type that happens to share a price", () => {
    // The flat type keys on NULL and the age-keyed type on ADULT, so their
    // maps differ even at the same amount — they must stay separate columns.
    expect(headings([
      type({ id: "full", name: "Full Member", sortOrder: 1, rates: [
        { ageTier: "ADULT", pricePerNightCents: 4000 },
      ] }),
      type({ id: "school", name: "School Group", sortOrder: 4, ageGroupsApply: false, rates: [
        { ageTier: null, pricePerNightCents: 4000 },
      ] }),
    ])).toEqual(["Full Member", "School Group"]);
  });

  it("returns no columns for an empty type list", () => {
    expect(collapseHutFeeColumns([])).toEqual([]);
  });
});
