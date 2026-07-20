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

  it("keys a flat type on the NULL tier and folds stray per-tier rows onto it", () => {
    const columns = collapseHutFeeColumns([
      type({ id: "school", name: "School Group", sortOrder: 4, ageGroupsApply: false, rates: [
        { ageTier: "ADULT", pricePerNightCents: 9000 },
        { ageTier: "CHILD", pricePerNightCents: 1000 },
      ] }),
    ]);
    expect(columns).toHaveLength(1);
    expect([...columns[0]!.prices.entries()]).toEqual([[null, 9000]]);
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
