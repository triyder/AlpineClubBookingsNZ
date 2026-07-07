import { describe, expect, it } from "vitest";

import { resolvePolicyRowsForLodge } from "@/lib/lodges";

// Direct coverage for the club-wide-with-override policy resolver (ADR-001
// resolved question 3). Previously only exercised via callers (booking-policies,
// cancellation); this pins the three rules the callers depend on:
//   (a) a lodge's own override rows REPLACE the club-wide (null lodgeId) rows —
//       never merged;
//   (b) another lodge's rows never leak into the resolved set; and
//   (c) rows from narrow selects (or fixtures) that omit lodgeId entirely are
//       treated as club-wide, same as an explicit null (loose == null check).
describe("resolvePolicyRowsForLodge", () => {
  it("replaces club-wide rows with the lodge's own override rows (never merges)", () => {
    const rows = [
      { id: "club-14d", lodgeId: null },
      { id: "club-7d", lodgeId: null },
      { id: "lodgeA-14d", lodgeId: "lodge-A" },
    ];

    const resolved = resolvePolicyRowsForLodge(rows, "lodge-A");

    expect(resolved.map((row) => row.id)).toEqual(["lodgeA-14d"]);
    // The club-wide rows are dropped, not appended alongside the override.
    expect(resolved).toHaveLength(1);
  });

  it("falls back to club-wide rows when the lodge has no override rows", () => {
    const rows = [
      { id: "club-14d", lodgeId: null },
      { id: "lodgeB-14d", lodgeId: "lodge-B" },
    ];

    const resolved = resolvePolicyRowsForLodge(rows, "lodge-A");

    expect(resolved.map((row) => row.id)).toEqual(["club-14d"]);
  });

  it("never includes another lodge's rows for the requested lodge", () => {
    const rows = [
      { id: "lodgeA-14d", lodgeId: "lodge-A" },
      { id: "lodgeB-14d", lodgeId: "lodge-B" },
      { id: "club-14d", lodgeId: null },
    ];

    const resolvedForA = resolvePolicyRowsForLodge(rows, "lodge-A");
    expect(resolvedForA.map((row) => row.id)).toEqual(["lodgeA-14d"]);
    expect(resolvedForA.some((row) => row.lodgeId === "lodge-B")).toBe(false);

    // And when lodge A has no override, the fallback still excludes lodge B.
    const clubOnly = rows.filter((row) => row.id !== "lodgeA-14d");
    const resolvedFallback = resolvePolicyRowsForLodge(clubOnly, "lodge-A");
    expect(resolvedFallback.map((row) => row.id)).toEqual(["club-14d"]);
  });

  it("treats rows missing the lodgeId column as club-wide (loose null check)", () => {
    // Narrow selects / fixtures may omit lodgeId; undefined must resolve as
    // club-wide, same as an explicit null, so it survives the fallback filter.
    const rows: { id: string; lodgeId?: string | null }[] = [
      { id: "club-no-column" },
      { id: "lodgeA-14d", lodgeId: "lodge-A" },
    ];

    // Requested lodge has an override → column-less club rows are excluded.
    expect(
      resolvePolicyRowsForLodge(rows, "lodge-A").map((row) => row.id)
    ).toEqual(["lodgeA-14d"]);

    // Requested lodge has no override → the column-less row is the club-wide
    // fallback and is returned.
    const clubOnlyRows: { id: string; lodgeId?: string | null }[] = [
      { id: "club-no-column" },
    ];
    expect(
      resolvePolicyRowsForLodge(clubOnlyRows, "lodge-A").map((row) => row.id)
    ).toEqual(["club-no-column"]);
  });
});
