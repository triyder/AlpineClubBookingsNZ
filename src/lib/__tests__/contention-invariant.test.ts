import { describe, expect, it } from "vitest";
import { evaluateContentionOccupancy } from "../../../load/lib/contention-invariant.js";

describe("contention occupancy invariant", () => {
  it("requires the exact capacity-limited occupancy delta", () => {
    expect(
      evaluateContentionOccupancy({
        baseline: 0,
        finalOccupied: 20,
        capacity: 20,
        attempts: 100,
      }),
    ).toEqual({ expectedFinal: 20, passed: true });

    expect(
      evaluateContentionOccupancy({
        baseline: 4,
        finalOccupied: 14,
        capacity: 20,
        attempts: 10,
      }),
    ).toEqual({ expectedFinal: 14, passed: true });
  });

  it("fails when even one expected capacity hold is omitted", () => {
    expect(
      evaluateContentionOccupancy({
        baseline: 0,
        finalOccupied: 19,
        capacity: 20,
        attempts: 100,
      }).passed,
    ).toBe(false);
    expect(
      evaluateContentionOccupancy({
        baseline: 4,
        finalOccupied: 13,
        capacity: 20,
        attempts: 10,
      }).passed,
    ).toBe(false);
  });

  it("fails an already over-capacity baseline", () => {
    expect(
      evaluateContentionOccupancy({
        baseline: 21,
        finalOccupied: 20,
        capacity: 20,
        attempts: 1,
      }).passed,
    ).toBe(false);
  });
});
