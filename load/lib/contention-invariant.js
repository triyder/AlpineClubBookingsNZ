/**
 * Exact occupancy oracle for the contention scenario. Keeping this free of
 * k6 imports lets Vitest prove that a missing capacity hold cannot pass.
 */
export function evaluateContentionOccupancy(input) {
  const expectedFinal = Math.min(
    input.capacity,
    input.baseline + input.attempts
  );
  return {
    expectedFinal: expectedFinal,
    passed:
      input.baseline >= 0 &&
      input.baseline <= input.capacity &&
      input.finalOccupied === expectedFinal,
  };
}
