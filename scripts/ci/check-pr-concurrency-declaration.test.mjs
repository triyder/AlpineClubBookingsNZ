import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  REQUIRED_FIELDS,
  selectPrBody,
  validateConcurrencyDeclaration,
} from "./check-pr-concurrency-declaration.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const heading = "## Concurrency And Lock Impact";
const complete = `${heading}

- Writer class(es), canonical lock key(s), and acquisition order: cancel; global -> lodge
- Immutable pre-lock key source and mutable under-lock re-read: immutable lodgeId; full re-read
- Status-guarded claim and proof that a lost claim runs no side effect: updateMany; count=0 exits
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #1911 uses the same lodge helper; race test passes
- Provider calls inside a transaction (write \`None\`, or justify the bounded exception from \`docs/CONCURRENCY_AND_LOCKING.md\`): None

## Residual Risks
`;

// A body that mirrors the REAL template: all five field bullets present, but
// fields 1-3 are left empty, field 4 carries only a `#number`, and field 5 has
// a value. Before the horizontal-whitespace fix, `\s` in the required-field
// regex consumed the newline after an empty bullet and captured the NEXT bullet
// line as the field value, so this bypassed the gate. It must now throw.
function blankFieldExploit(newline) {
  return [
    heading,
    "",
    "- Writer class(es), canonical lock key(s), and acquisition order:",
    "- Immutable pre-lock key source and mutable under-lock re-read:",
    "- Status-guarded claim and proof that a lost claim runs no side effect:",
    "- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #123",
    "- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None",
    "",
    "## Residual Risks",
    "",
  ].join(newline);
}

describe("PR concurrency declaration gate", () => {
  it("accepts a complete declaration with numbered compatibility evidence", () => {
    expect(() => validateConcurrencyDeclaration(complete)).not.toThrow();
  });

  it("accepts a complete declaration whose bullets use CRLF line endings", () => {
    expect(() => validateConcurrencyDeclaration(complete.replace(/\n/g, "\r\n"))).not.toThrow();
  });

  it("accepts an explicitly checked N/A declaration", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — docs-only change.\n`, [
        "docs/agents/CODEX_WORKFLOW.md",
      ]),
    ).not.toThrow();
  });

  it("rejects N/A when a concurrency-sensitive path changed", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — no impact.\n`, [
        "src/lib/booking-cancel.ts",
      ]),
    ).toThrow(/cannot use N\/A/);
  });

  it("rejects template placeholders and unnumbered compatibility claims", () => {
    expect(() => validateConcurrencyDeclaration(`${heading}\n\n- Writer class(es), canonical lock key(s), and acquisition order:\n`)).toThrow(
      /must complete/,
    );
    expect(() =>
      validateConcurrencyDeclaration(complete.replace("#1911", "recent work")),
    ).toThrow(/PR number/);
  });

  it("rejects the real-template blank-field bypass (LF) where only field 4 is filled", () => {
    expect(() => validateConcurrencyDeclaration(blankFieldExploit("\n"))).toThrow(
      /must complete/,
    );
  });

  it("rejects the real-template blank-field bypass (CRLF) where only field 4 is filled", () => {
    expect(() => validateConcurrencyDeclaration(blankFieldExploit("\r\n"))).toThrow(
      /must complete/,
    );
  });

  it("does not accept a value that sits on the line after the label", () => {
    const nextLineValue = [
      heading,
      "",
      "- Writer class(es), canonical lock key(s), and acquisition order:",
      "  cancel; global -> lodge",
      "- Immutable pre-lock key source and mutable under-lock re-read: x",
      "- Status-guarded claim and proof that a lost claim runs no side effect: x",
      "- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: #1",
      "- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None",
      "",
    ].join("\n");
    expect(() => validateConcurrencyDeclaration(nextLineValue)).toThrow(/must complete/);
  });

  it("rejects a field whose value is only whitespace", () => {
    const whitespaceValue = complete.replace(
      "acquisition order: cancel; global -> lodge",
      "acquisition order:    ",
    );
    expect(() => validateConcurrencyDeclaration(whitespaceValue)).toThrow(/must complete/);
  });

  it("lets a test-only change check N/A even though the path name looks sensitive", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — test-only change.\n`, [
        "src/lib/__tests__/booking-cancel-split.test.ts",
      ]),
    ).not.toThrow();
  });

  it("still requires a full declaration when a test accompanies real sensitive source", () => {
    expect(() =>
      validateConcurrencyDeclaration(`${heading}\n\n- [x] N/A — no impact.\n`, [
        "src/lib/__tests__/booking-cancel-split.test.ts",
        "src/lib/booking-cancel.ts",
      ]),
    ).toThrow(/cannot use N\/A/);
  });

  it("selectPrBody prefers a successfully fetched live body over the event payload", () => {
    expect(selectPrBody({ fetchedBody: "live", eventBody: "stale" })).toBe("live");
    // An empty fetched body still wins (fetch succeeded) so the gate fails closed.
    expect(selectPrBody({ fetchedBody: "", eventBody: "stale" })).toBe("");
  });

  it("selectPrBody falls back to the event body only when the fetch failed", () => {
    expect(selectPrBody({ fetchedBody: null, eventBody: "event" })).toBe("event");
    expect(selectPrBody({ fetchedBody: null, eventBody: undefined })).toBe("");
  });

  it("keeps REQUIRED_FIELDS labels in lockstep with the PR template bullets", () => {
    const template = readFileSync(resolve(repoRoot, ".github/pull_request_template.md"), "utf8");
    for (const field of REQUIRED_FIELDS) {
      expect(template).toContain(`- ${field}:`);
    }
  });
});
