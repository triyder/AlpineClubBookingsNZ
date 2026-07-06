#!/usr/bin/env npx tsx
import "dotenv/config";
import { formatBookingXeroRepairHumanSummary, runBookingXeroRepair } from "../src/lib/xero-booking-repair";
import { prisma } from "../src/lib/prisma";

function printUsage() {
  console.log(`Usage:
  npx tsx scripts/xero-booking-repair.ts --dry-run
  npx tsx scripts/xero-booking-repair.ts --booking <bookingId> --dry-run
  npx tsx scripts/xero-booking-repair.ts --apply
  npx tsx scripts/xero-booking-repair.ts --from <YYYY-MM-DD> --to <YYYY-MM-DD> --apply
  npx tsx scripts/xero-booking-repair.ts --apply --apply-action <actionKey>

--apply-action executes ONE not-safeToAutoApply action you have verified from
a prior dry-run report (repeatable; exact action key match; requires --apply).
`);
}

function parseDateInput(value: string, name: string) {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`${name} must use YYYY-MM-DD format.`);
  }

  const parsed = new Date(`${trimmed}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} is not a valid date.`);
  }

  return parsed;
}

function parseArgs(argv: string[]) {
  const options: {
    apply: boolean;
    bookingId?: string;
    from?: Date;
    to?: Date;
    all: boolean;
    applyActionKeys: string[];
  } = {
    apply: false,
    all: false,
    applyActionKeys: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--apply") {
      options.apply = true;
      continue;
    }

    if (arg === "--apply-action") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--apply-action requires an action key value.");
      }
      options.applyActionKeys.push(value);
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      options.apply = false;
      continue;
    }

    if (arg === "--all") {
      options.all = true;
      continue;
    }

    if (arg === "--booking") {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error("--booking requires a booking id.");
      }
      options.bookingId = nextValue;
      index += 1;
      continue;
    }

    if (arg === "--from") {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error("--from requires a YYYY-MM-DD date.");
      }
      options.from = parseDateInput(nextValue, "--from");
      index += 1;
      continue;
    }

    if (arg === "--to") {
      const nextValue = argv[index + 1];
      if (!nextValue) {
        throw new Error("--to requires a YYYY-MM-DD date.");
      }
      options.to = parseDateInput(nextValue, "--to");
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.from && options.to && options.from > options.to) {
    throw new Error("--from must be on or before --to.");
  }

  if (!options.bookingId && !options.from && !options.to) {
    options.all = true;
  }

  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.applyActionKeys.length > 0 && !args.apply) {
    throw new Error("--apply-action requires --apply.");
  }

  const report = await runBookingXeroRepair({
    apply: args.apply,
    applyActionKeys: args.applyActionKeys,
    scope: {
      bookingId: args.bookingId,
      from: args.from,
      to: args.to,
      all: args.all,
    },
  });

  console.log(formatBookingXeroRepairHumanSummary(report));

  if (report.summary.unmatchedForcedActionKeys.length > 0) {
    console.warn(
      `WARNING: --apply-action key(s) matched no planned action (typo or stale amount) — nothing was executed for: ${report.summary.unmatchedForcedActionKeys.join(", ")}`
    );
  }
  console.log("");
  console.log("---BEGIN XERO BOOKING REPAIR JSON---");
  console.log(JSON.stringify(report, null, 2));
  console.log("---END XERO BOOKING REPAIR JSON---");
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Unknown xero-booking-repair error"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
  });
