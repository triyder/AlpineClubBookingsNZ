/**
 * Read-only audit of settled bank-transfer receipts whose recorded figure is
 * not the cash Xero recorded against their invoice (#3979, `INV-PAY-125`).
 *
 * REPORT ONLY - this script never writes, never repairs and never calls a live
 * provider. It reads the payment links the inbound invoice sync stored. The
 * arithmetic and its caveats live in `src/lib/ib-settled-cash-audit.ts`.
 *
 * SAFE USAGE - run against a NON-PRODUCTION copy:
 *
 *   DATABASE_URL='postgresql://user:pass@127.0.0.1:5432/scratch_copy' \
 *     pnpm run payments:audit-ib-settled-cash
 */
import "dotenv/config";
import process from "node:process";

import { auditIbSettledCash, formatIbSettledCashReport } from "../src/lib/ib-settled-cash-audit";
import { prisma } from "../src/lib/prisma";
import { getClubFormat } from "../src/lib/club-format-settings";

function printUsage() {
  console.log(`Usage:
  pnpm run payments:audit-ib-settled-cash         # read-only audit (default)
  pnpm run payments:audit-ib-settled-cash --json  # also emit machine-readable JSON

This audit is read-only. It never writes and never calls Xero/Stripe/SES.

Options:
  --json          Emit machine-readable JSON alongside the human report.
  --help, -h      Show this help.
`);
}

async function main() {
  // A POSIX shell forwards a literal `--` if somebody writes one; skip it, as
  // `scripts/audit-refunded-total-shortfall.ts` does.
  const argv = process.argv.slice(2).filter((arg) => arg !== "--");
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  for (const arg of argv) {
    if (arg !== "--json") throw new Error(`Unknown argument: ${arg}`);
  }

  // The club's format (#3565), read once before the audit query.
  const format = await getClubFormat();
  const result = await auditIbSettledCash();
  console.log(formatIbSettledCashReport(result, format));

  if (argv.includes("--json")) {
    console.log("");
    console.log(JSON.stringify(result, null, 2));
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : "Unknown settled-cash audit error");
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
