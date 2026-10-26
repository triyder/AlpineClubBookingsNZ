import { describe, expect, it } from "vitest";

import {
  isPaymentRecoveryOperationExhausted,
  isPaymentRecoveryOperationInFlight,
  MAX_PAYMENT_RECOVERY_ATTEMPTS,
  PAYMENT_RECOVERY_EXHAUSTED_WHERE,
  PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE,
} from "@/lib/payment-recovery-constants";

/*
  #4036 review: the Prisma filter is the in-flight predicate's twin, not a
  second rule. This evaluates the filter the way Postgres would on each row
  shape and holds it to the predicate.
*/

type Row = { status: "PENDING" | "PROCESSING" | "SUCCEEDED" | "FAILED"; attempts: number; nextRetryAt: Date | null };

/** One where arm, evaluated as Postgres would on the row: every field it names must hold. */
type Arm = {
  status?: string | { in: readonly string[] };
  attempts?: { lt?: number; gte?: number };
  nextRetryAt?: { not: null };
};
function armMatches(arm: Arm, row: Row): boolean {
  if (typeof arm.status === "string" && row.status !== arm.status) return false;
  if (typeof arm.status === "object" && !arm.status.in.includes(row.status)) return false;
  if (arm.attempts?.lt !== undefined && !(row.attempts < arm.attempts.lt)) return false;
  if (arm.attempts?.gte !== undefined && !(row.attempts >= arm.attempts.gte)) return false;
  if (arm.nextRetryAt && row.nextRetryAt === null) return false;
  return true;
}
function filterMatches(row: Row): boolean {
  return (PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE.OR as readonly Arm[]).some((arm) => armMatches(arm, row));
}

const RETRY = new Date("2026-07-01T00:05:00.000Z");
const ROWS: Row[] = [];
for (const status of ["PENDING", "PROCESSING", "SUCCEEDED", "FAILED"] as const) {
  for (const attempts of [0, MAX_PAYMENT_RECOVERY_ATTEMPTS - 1, MAX_PAYMENT_RECOVERY_ATTEMPTS]) {
    for (const nextRetryAt of [RETRY, null]) ROWS.push({ status, attempts, nextRetryAt });
  }
}

describe("PAYMENT_RECOVERY_OPERATION_IN_FLIGHT_WHERE (#4036 review)", () => {
  it.each(ROWS.map((row) => [`${row.status} attempts=${row.attempts} retry=${row.nextRetryAt ? "set" : "none"}`, row] as const))(
    "agrees with isPaymentRecoveryOperationInFlight: %s",
    (_label, row) => {
      expect(filterMatches(row)).toBe(isPaymentRecoveryOperationInFlight(row));
    },
  );

  it("counts a FAILED row with a retry scheduled and attempts left as in flight", () => {
    expect(filterMatches({ status: "FAILED", attempts: 1, nextRetryAt: RETRY })).toBe(true);
  });
});

describe("PAYMENT_RECOVERY_EXHAUSTED_WHERE (#4104 review, CL4)", () => {
  it.each(ROWS.map((row) => [`${row.status} attempts=${row.attempts} retry=${row.nextRetryAt ? "set" : "none"}`, row] as const))(
    "agrees with isPaymentRecoveryOperationExhausted: %s",
    (_label, row) => {
      expect(armMatches(PAYMENT_RECOVERY_EXHAUSTED_WHERE as Arm, row)).toBe(isPaymentRecoveryOperationExhausted(row));
    },
  );

  it("MUTATION (CL5): a card refund raised dead - PENDING at the attempt ceiling - is exhausted, never in flight", () => {
    const raisedDead: Row = { status: "PENDING", attempts: MAX_PAYMENT_RECOVERY_ATTEMPTS, nextRetryAt: RETRY };
    expect(isPaymentRecoveryOperationExhausted(raisedDead)).toBe(true);
    expect(isPaymentRecoveryOperationInFlight(raisedDead)).toBe(false);
    expect(filterMatches(raisedDead)).toBe(false);
    // A PENDING row with attempts left is in flight whatever its retry time.
    expect(isPaymentRecoveryOperationInFlight({ status: "PENDING", attempts: 0, nextRetryAt: null })).toBe(true);
  });
});
