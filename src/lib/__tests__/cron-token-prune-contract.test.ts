import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The daily `data-pruning` cron in src/instrumentation.node.ts sweeps every
// ephemeral auth/token table so single-use and expired rows do not accumulate.
// We read the source statically instead of importing it: the module registers
// real node-cron schedules at import time, which must never be started from a
// unit test (mirroring cron-recording-health-contract.test.ts).
//
// This pins the token-prune set. Adding a new ephemeral token table without a
// matching prune step — or dropping one — fails here (#2034 added
// magicLinkToken; its rows are single-use, so it prunes expired OR used).

function readInstrumentationSource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src/instrumentation.node.ts"),
    "utf8",
  );
}

const EXPIRY_ONLY_TOKEN_PRUNES = [
  "emailVerificationToken",
  "emailChangeToken",
  "guestChoreToken",
  "passwordResetToken",
] as const;

describe("daily data-pruning token sweep contract (#2034)", () => {
  const source = readInstrumentationSource();

  it.each(EXPIRY_ONLY_TOKEN_PRUNES)(
    "prunes expired %s rows",
    (model) => {
      expect(source).toContain(`prisma.${model}.deleteMany`);
      // The expiry-only tables prune purely on the expiresAt window.
      const stepRegex = new RegExp(
        `prisma\\.${model}\\.deleteMany\\(\\{\\s*where:\\s*\\{\\s*expiresAt:\\s*\\{\\s*lt:`,
      );
      expect(source).toMatch(stepRegex);
    },
  );

  it("prunes magic-link tokens on expired OR used (single-use, inert once claimed)", () => {
    expect(source).toContain('runStep("prune-magic-link-tokens"');
    expect(source).toContain("prisma.magicLinkToken.deleteMany");
    // Used rows are swept alongside expired ones.
    const magicPrune = new RegExp(
      `prisma\\.magicLinkToken\\.deleteMany\\(\\{\\s*where:\\s*\\{\\s*OR:\\s*\\[\\s*\\{\\s*expiresAt:\\s*\\{\\s*lt:[^\\]]*used:\\s*true`,
    );
    expect(source).toMatch(magicPrune);
  });
});
