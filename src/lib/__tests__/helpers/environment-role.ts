/**
 * Declaring the environment role a suite means to run under (ENV-SAFETY 2,
 * #3035; epic #2986; INV-CONFIG-003 / INV-CONFIG-004).
 *
 * WHY EVERY SEND-PATH SUITE NEEDS THIS, and why it is a helper rather than two
 * lines copied around. `resolveEnvironmentRole()` answers from two sources: the
 * `APP_ENVIRONMENT_ROLE` declaration and the `EnvironmentSafetySettings` row. In
 * the unit suite BOTH are absent by default — the variable is unset, and almost
 * every test mocks `@/lib/prisma` with a partial object naming only the delegates
 * it uses, so `prisma.environmentSafetySettings` does not exist. A missing
 * delegate is `unreadable`, not `none` (see `environment-role.ts`), so the role
 * resolves **UNKNOWN** and #3035's delivery boundary withholds every message.
 *
 * That default is deliberate #3034 behaviour and it is the safe one. It does mean
 * a test that expects a send has to SAY which installation it is pretending to
 * be, in both halves:
 *
 * ```ts
 * vi.mock("@/lib/prisma", () => ({
 *   prisma: {
 *     emailLog: { ... },
 *     // No override, which is the ordinary state of an installation that has
 *     // never used the safer switch. Written INLINE rather than imported from
 *     // this helper on purpose: `vi.mock` factories and `vi.hoisted` blocks are
 *     // hoisted above the file's imports, so a helper binding is not reliably
 *     // initialised when they run.
 *     environmentSafetySettings: { findUnique: vi.fn().mockResolvedValue(null) },
 *   },
 * }));
 * // ...
 * beforeEach(() => {
 *   declareEnvironmentRole("production");
 * });
 * ```
 *
 * A suite that wants the other override states reaches for them on that same
 * delegate: `mockResolvedValue({ forceNonProduction: true, updatedAt: new
 * Date(0), updatedByMemberId: null })` for an administrator-forced copy, or
 * `mockRejectedValue(new Error("boom"))` for the unreadable case.
 *
 * ONE HALF IS NOT ENOUGH, except in one direction. A declared `non-production` is
 * final and no database state can move it, so suppressing suites need only the
 * declaration. A declared `production` still consults the override, so a suite
 * that wants a SEND needs the delegate as well — without it the declaration is
 * overruled by an unreadable override and the suite silently tests the UNKNOWN
 * path instead. {@link expectEnvironmentRolePremise} exists so that mistake fails
 * with a sentence rather than as a mysterious "no message was sent".
 */
import { expect, vi } from "vitest";

import {
  ENVIRONMENT_ROLE_ENV_VAR,
  type EnvironmentRoleDeclaration,
} from "@/lib/environment-role-declaration";
import { getEnvironmentRole, type EnvironmentRole } from "@/lib/environment-role";

/**
 * Declare what this suite's installation is.
 *
 * Uses `vi.stubEnv`, so it is undone by `vi.unstubAllEnvs()` and by vitest's own
 * teardown at the end of the FILE. A separate test file therefore cannot leak a
 * production declaration into the next one — but the race harness imports some
 * forty suites into one file, where nothing undoes it until all of them have
 * run (#4107): there, use {@link declareEnvironmentRoleForSuite}.
 * Call it in `beforeEach`, AFTER any `vi.unstubAllEnvs()` the suite already does.
 */
export function declareEnvironmentRole(
  value: "production" | "non-production" | (string & {}),
): void {
  vi.stubEnv(ENVIRONMENT_ROLE_ENV_VAR, value);
}

/** What {@link declareEnvironmentRoleForSuite} found, and what puts it back. */
export interface SuiteEnvironmentRoleDeclaration {
  /** The variable as the suite found it; `undefined` when it was unset. */
  readonly before: string | undefined;
  /** Put the variable back exactly as it was found. Safe to call twice. */
  restore(): void;
}

/**
 * Declare the role for ONE suite of a shared harness, and get back the means to
 * undo exactly that (#4013).
 *
 * The real-PostgreSQL race harness imports some forty suites into one file
 * (`concurrency-lock-races.realdb.test.ts`), so "the next file" never comes:
 * a declaration made in one suite's `beforeAll` is still there for every suite
 * after it. {@link declareEnvironmentRole} is the wrong tool there twice over —
 * nothing unstubs it until the whole file ends, and `vi.unstubAllEnvs()` would
 * also undo every other suite's stubs. This writes the one variable and puts
 * back the one variable. Call it in `beforeAll`, call `restore()` in a `finally`
 * in the matching `afterAll`, and add a describe AFTER the suite that asserts
 * the variable equals `before` again, so a missed restore fails by name rather
 * than arming whichever suite runs next.
 */
export function declareEnvironmentRoleForSuite(
  // Only the safe declaration: a shared harness pretending to be the club's
  // live site would arm every send and Xero write for the suites after it.
  value: "non-production",
): SuiteEnvironmentRoleDeclaration {
  const before = process.env[ENVIRONMENT_ROLE_ENV_VAR];
  process.env[ENVIRONMENT_ROLE_ENV_VAR] = value;
  return {
    before,
    restore() {
      if (before === undefined) delete process.env[ENVIRONMENT_ROLE_ENV_VAR];
      else process.env[ENVIRONMENT_ROLE_ENV_VAR] = before;
    },
  };
}

/** Remove the declaration, so the role resolves UNKNOWN on that half. */
export function undeclareEnvironmentRole(): void {
  vi.stubEnv(ENVIRONMENT_ROLE_ENV_VAR, "");
}

/**
 * The premise guard: assert this suite really is running under the role it thinks
 * it is, before any assertion about sending or not sending.
 *
 * Same purpose as `expectClubTimeZonePremise` — one environment failure that says
 * what is wrong beats a dozen assertions that read like the product bug the suite
 * exists to prove fixed.
 */
export async function expectEnvironmentRolePremise(
  expected: EnvironmentRole,
): Promise<void> {
  expect(
    await getEnvironmentRole(),
    `This suite means to run as ${expected}. It is not, so #3035's delivery ` +
      `boundary will behave differently from what the assertions below expect. ` +
      `Check BOTH halves: declareEnvironmentRole("...") for the ` +
      `${ENVIRONMENT_ROLE_ENV_VAR} declaration, and ` +
      `an environmentSafetySettings delegate in the @/lib/prisma mock factory — ` +
      `a missing one is an UNREADABLE override, which resolves UNKNOWN even ` +
      `under a declared production. A suite that expects a SEND from a copy ` +
      `also has to declare a capture transport (USE_LOCAL_CAPTURE).`,
  ).toBe(expected);
}

/** A declaration literal, for tests of the pure policy mapping. */
export const environmentRoleDeclaration = {
  production: { kind: "production" } as EnvironmentRoleDeclaration,
  nonProduction: { kind: "non-production" } as EnvironmentRoleDeclaration,
  absent: { kind: "absent" } as EnvironmentRoleDeclaration,
  invalid: { kind: "invalid", raw: "staging" } as EnvironmentRoleDeclaration,
};
