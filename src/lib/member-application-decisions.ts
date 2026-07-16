import { z } from "zod";

// E10 (#1936): the pure decision vocabulary shared by the approval route, the
// preview route, the server mapping engine, and the UI. Intentionally free of
// `server-only`, Prisma, and any server import so route handlers (and their
// tests) can validate/normalize decisions without pulling the server engine.

export type PersonRef = { kind: "applicant" } | { kind: "family"; index: number };

export type PersonDecisionInput =
  | { mode: "CREATE" }
  | { mode: "MAP"; memberId: string };

export const personDecisionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("CREATE") }),
  z.object({ mode: z.literal("MAP"), memberId: z.string().min(1) }),
]);

export const personDecisionsSchema = z.object({
  applicant: personDecisionSchema,
  family: z.array(personDecisionSchema),
});

export type PersonDecisions = z.infer<typeof personDecisionsSchema>;

export type NormalizedPersonDecision = {
  ref: PersonRef;
  decision: PersonDecisionInput;
};

export type DecisionResolution =
  | { ok: true; decisions: NormalizedPersonDecision[]; mapTargetIds: string[] }
  | { ok: false; status: number; error: string };

export function refKey(ref: PersonRef): string {
  return ref.kind === "applicant" ? "applicant" : `family:${ref.index}`;
}

/**
 * Normalize the per-person decisions against the application's family shape.
 * Absent decisions default to all-CREATE (byte-identical current behavior).
 */
export function resolvePersonDecisions(
  familyCount: number,
  personDecisions: PersonDecisions | null | undefined,
): DecisionResolution {
  if (!personDecisions) {
    const decisions: NormalizedPersonDecision[] = [
      { ref: { kind: "applicant" }, decision: { mode: "CREATE" } },
      ...Array.from({ length: familyCount }, (_, index) => ({
        ref: { kind: "family" as const, index },
        decision: { mode: "CREATE" as const },
      })),
    ];
    return { ok: true, decisions, mapTargetIds: [] };
  }

  if (personDecisions.family.length !== familyCount) {
    return {
      ok: false,
      status: 422,
      error: `Family decision count (${personDecisions.family.length}) does not match the application's ${familyCount} family member(s).`,
    };
  }

  const decisions: NormalizedPersonDecision[] = [
    { ref: { kind: "applicant" }, decision: personDecisions.applicant },
    ...personDecisions.family.map((decision, index) => ({
      ref: { kind: "family" as const, index },
      decision,
    })),
  ];

  const mapTargetIds = decisions
    .map(({ decision }) => (decision.mode === "MAP" ? decision.memberId : null))
    .filter((value): value is string => Boolean(value));

  return { ok: true, decisions, mapTargetIds: [...new Set(mapTargetIds)].sort() };
}
