import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #182 guard (process follow-up to upstream PR #1911 review finding H1): the
// per-lodge capacity lock replaced the historical club-wide
// pg_advisory_xact_lock(1) for every capacity ADMISSION path, but one route
// (confirm-pending-guests) was left on the legacy key — a disjoint advisory
// key that never mutually excludes, silently unserialising the exclusive-hold
// guard (#172). This scan makes that regression class a CI failure instead of
// an upstream review comment:
//
// 1. The legacy club-wide lock(1) survives ONLY in a frozen inventory of
//    non-admission flows (settlement, cancel, reminder crons, Xero inbound —
//    including one deliberate two-lock composition in invoice-paid-effects).
//    A NEW lock(1) call site is almost certainly an admission path copying
//    the legacy pattern: use acquireLodgeCapacityLock (src/lib/capacity.ts)
//    instead, or — for a genuinely non-capacity serialisation need — prefer a
//    domain-keyed lock (pg_advisory_xact_lock(hashtext('my-domain:...'))) and
//    only then, with justification in the PR, update the inventory below.
//
// 2. The per-lodge key is minted ONLY by acquireLodgeCapacityLock:
//    hashtextextended must not appear outside src/lib/capacity.ts, so an
//    ad-hoc reconstruction can never drift from the canonical key.
//
// Domain-keyed advisory locks (hashtext of a namespaced string) are
// unrestricted — they are deliberately distinct keyspaces.

const SRC_DIR = path.join(process.cwd(), "src");

// Frozen per-file inventory of legacy club-wide lock(1) call sites
// (executeRaw occurrences, not comments), as at #172 landing. Shrinking a
// count is always fine (delete the entry at zero); growing one needs an
// explicit justification in the PR that edits this file.
const LEGACY_CLUB_WIDE_LOCK_INVENTORY: Record<string, number> = {
  "src/lib/booking-cancel.ts": 4,
  "src/lib/cron-group-settlement-reaper.ts": 2,
  "src/lib/cron-quote-expiry-reminders.ts": 2,
  "src/lib/internet-banking-payment-cron.ts": 1,
  "src/lib/xero-inbound/credit-note-repairs.ts": 1,
  "src/lib/xero-inbound/invoice-paid-effects.ts": 1,
};

const CAPACITY_LOCK_MINT = "src/lib/capacity.ts";

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, files);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__") ||
    /\.(test|spec)\.tsx?$/.test(relPath) ||
    relPath.includes(".integration.")
  );
}

/** Count non-comment source lines in `source` matching `needle`. */
function countCodeOccurrences(source: string, needle: string): number {
  let count = 0;
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
      continue;
    }
    let idx = line.indexOf(needle);
    while (idx !== -1) {
      count += 1;
      idx = line.indexOf(needle, idx + needle.length);
    }
  }
  return count;
}

describe("advisory lock guard (#182 / H1 regression class)", () => {
  const sources = walk(SRC_DIR)
    .map((file) => ({
      rel: path.relative(process.cwd(), file).split(path.sep).join("/"),
      text: fs.readFileSync(file, "utf8"),
    }))
    .filter(({ rel }) => !isTestFile(rel));

  it("keeps the legacy club-wide pg_advisory_xact_lock(1) inside the frozen inventory", () => {
    const found: Record<string, number> = {};
    for (const { rel, text } of sources) {
      const count = countCodeOccurrences(text, "pg_advisory_xact_lock(1)");
      if (count > 0) found[rel] = count;
    }

    expect(
      found,
      "New pg_advisory_xact_lock(1) call sites detected. Capacity admissions " +
        "must use acquireLodgeCapacityLock(tx, lodgeId) (src/lib/capacity.ts) — " +
        "the club-wide key is DISJOINT from the per-lodge key and does not " +
        "serialise against admissions or exclusive-hold setting (PR #1911 " +
        "review, H1). For a genuinely non-capacity serialisation need, prefer " +
        "a domain-keyed hashtext lock; only update this inventory with " +
        "justification in the PR."
    ).toEqual(LEGACY_CLUB_WIDE_LOCK_INVENTORY);
  });

  it("mints the per-lodge capacity key only in capacity.ts", () => {
    const offenders = sources
      .filter(({ rel }) => rel !== CAPACITY_LOCK_MINT)
      .filter(({ text }) => countCodeOccurrences(text, "hashtextextended") > 0)
      .map(({ rel }) => rel);

    expect(
      offenders,
      "hashtextextended found outside src/lib/capacity.ts. The per-lodge " +
        "capacity key must only be constructed by acquireLodgeCapacityLock so " +
        "every participant provably shares one key — call the helper instead " +
        "of rebuilding the expression."
    ).toEqual([]);
  });
});
