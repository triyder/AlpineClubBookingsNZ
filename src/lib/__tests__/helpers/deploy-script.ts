import { expect } from "vitest";

/**
 * Lifting one function out of `scripts/run-production-blue-green-deploy.sh` so a
 * suite can RUN it under a stub harness rather than grep its text (#3965,
 * #4026, #4027).
 *
 * The deploy script needs a production host, Docker and a live release, so it is
 * never executed whole in a test. Several suites instead copy the functions they
 * prove into a throwaway harness, stub `docker` and friends, and run that. They
 * all need the same bounds rule, so it lives here once.
 */

/** The deploy script's path, relative to the repository root. */
export const DEPLOY_SCRIPT = "scripts/run-production-blue-green-deploy.sh";

/**
 * A top-level shell function's whole definition, from `name() {` at the start of
 * a line to the next `}` at the start of a line, closing brace and newline
 * included, ready to paste into a harness.
 *
 * Anchored at a line start so `foo` cannot match inside `bar_foo() {`, and
 * asserted present, so a renamed function fails the suite by name instead of
 * pasting nothing into the harness.
 */
export function shellFunctionSource(script: string, name: string): string {
  const start = script.indexOf(`\n${name}() {`);
  expect(start, `${name} must be defined in the deploy script`).toBeGreaterThan(0);
  const end = script.indexOf("\n}\n", start);
  expect(end, `${name} must have a closing brace`).toBeGreaterThan(start);
  return script.slice(start + 1, end + 3);
}
