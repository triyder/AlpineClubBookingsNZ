/**
 * #4107: THE RACE HARNESS LEAVES `process.env` AS IT FOUND IT.
 *
 * `concurrency-lock-races.realdb.test.ts` imports some forty suites into one
 * file, so "the next file" never comes: a variable one suite writes in its
 * `beforeAll` - a `vi.stubEnv`, an `APP_ENVIRONMENT_ROLE` declaration, a raw
 * `process.env.X =` - is still set for every suite imported after it, and a
 * later suite then passes or fails on an order it does not know about (#4013).
 *
 * Imported FIRST by the harness, this snapshots the environment before any
 * suite's hooks run, and registers the harness's first `afterAll`. Hooks run
 * as a stack (`vitest.config.mts`, `sequence.hooks: "stack"`), so that check
 * runs LAST, once every imported suite has torn down, and names each variable
 * left changed, added or removed. A suite fixes a failure by putting back the
 * one variable it changed: `declareEnvironmentRoleForSuite`'s `restore()`, or
 * the value it saved, restored in its own `afterAll` (as
 * `xero-token-credential-store.realdb.test.ts` does for `AUTH_SECRET`). Never
 * `vi.unstubAllEnvs()`: in this harness it undoes every other suite's stubs too.
 *
 * IT CHECKS THE END STATE. A later suite's blanket restore can therefore hide
 * an earlier suite's leak from this check, though not from the suites that ran
 * in between - which is one more reason never to restore in bulk here.
 *
 * One variable is exempt: `DATABASE_URL` pointed at the race database itself.
 * Every suite points the app's Prisma singleton there on purpose, before it
 * connects, and nothing after the harness reads it.
 */
import { afterAll, expect } from "vitest";

export type EnvSnapshot = Readonly<Record<string, string | undefined>>;

/** Each variable that differs between two snapshots, by name, sorted. */
export function envDrift(before: EnvSnapshot, after: EnvSnapshot, raceDbUrl: string): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((name) => before[name] !== after[name])
    .filter((name) => !(name === "DATABASE_URL" && raceDbUrl !== "" && after[name] === raceDbUrl))
    .sort();
}

const before: EnvSnapshot = { ...process.env };

afterAll(() => {
  const drifted = envDrift(before, { ...process.env }, process.env.CONCURRENCY_RACE_DATABASE_URL ?? "");
  expect(
    drifted,
    "#4107: a race-harness suite left these environment variables changed for every suite after it; put each back in that suite's afterAll",
  ).toEqual([]);
});
