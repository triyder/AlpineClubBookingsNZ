#!/usr/bin/env tsx
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { clubConfigSchema, type ClubConfig } from "../src/config/schema";
// Single canonical boot-safe default (epic #1943, child C1). Imported from the
// side-effect-free module so the setup CLI does not trigger club.ts's eager
// `clubConfig` singleton load. This is the same constant the runtime loader uses
// as its last-resort default — no duplicate default can drift out of sync.
import { SAFE_DEFAULT_CONFIG } from "../src/config/safe-default-config";
import {
  buildSetupReadiness,
  getSetupRequiredEnvNames,
  renderSetupCheckReport,
} from "../src/lib/setup-readiness";

type AgeTierConfig = ClubConfig["ageTiers"][number];

const CONFIG_DIR = path.join(process.cwd(), "config");
const CLUB_CONFIG_PATH = path.join(CONFIG_DIR, "club.json");
const EXAMPLE_CONFIG_PATH = path.join(CONFIG_DIR, "club.example.json");

const DEFAULT_CONFIG: ClubConfig = SAFE_DEFAULT_CONFIG;

function readJson(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadDefaultConfig(): ClubConfig {
  const candidates = [
    readJson(CLUB_CONFIG_PATH),
    readJson(EXAMPLE_CONFIG_PATH),
    DEFAULT_CONFIG,
  ];
  for (const candidate of candidates) {
    const parsed = clubConfigSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return DEFAULT_CONFIG;
}

async function ask(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: string,
) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askInt(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: number,
) {
  const raw = await ask(rl, label, String(defaultValue));
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

async function askBoolean(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultValue: boolean,
) {
  const raw = (
    await ask(rl, `${label} (y/n)`, defaultValue ? "y" : "n")
  ).toLowerCase();
  if (["y", "yes", "true"].includes(raw)) return true;
  if (["n", "no", "false"].includes(raw)) return false;
  throw new Error(`${label} must be answered y or n`);
}

async function askCents(
  rl: ReturnType<typeof createInterface>,
  label: string,
  defaultCents: number,
) {
  const raw = await ask(rl, `${label} dollars`, (defaultCents / 100).toFixed(2));
  const dollars = Number.parseFloat(raw);
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error(`${label} must be a non-negative amount`);
  }
  return Math.round(dollars * 100);
}

function sortAgeTiers(tiers: AgeTierConfig[]) {
  const order = new Map([
    ["INFANT", 0],
    ["CHILD", 1],
    ["YOUTH", 2],
    ["ADULT", 3],
  ]);
  return [...tiers].sort((left, right) => {
    return (order.get(left.id) ?? 99) - (order.get(right.id) ?? 99);
  });
}

async function collectAgeTiers(
  rl: ReturnType<typeof createInterface>,
  defaults: AgeTierConfig[],
) {
  const keepDefaults = await askBoolean(
    rl,
    "Use the existing four age tiers and rate defaults",
    true,
  );
  if (keepDefaults) return sortAgeTiers(defaults);

  const tiers = sortAgeTiers(defaults);
  const result: AgeTierConfig[] = [];
  for (const tier of tiers) {
    const label = await ask(rl, `${tier.id} label`, tier.label);
    const minAge = await askInt(rl, `${tier.id} minimum age`, tier.minAge);
    const subscriptionRequiredForBooking = await askBoolean(
      rl,
      `${tier.id} requires paid subscription to book as member`,
      tier.subscriptionRequiredForBooking,
    );
    result.push({
      ...tier,
      label,
      minAge,
      maxAge: tier.maxAge,
      subscriptionRequiredForBooking,
      nightlyRates: {
        winter: {
          memberCents: await askCents(
            rl,
            `${tier.id} winter member nightly rate`,
            tier.nightlyRates.winter.memberCents,
          ),
          nonMemberCents: await askCents(
            rl,
            `${tier.id} winter non-member nightly rate`,
            tier.nightlyRates.winter.nonMemberCents,
          ),
        },
        summer: {
          memberCents: await askCents(
            rl,
            `${tier.id} summer member nightly rate`,
            tier.nightlyRates.summer.memberCents,
          ),
          nonMemberCents: await askCents(
            rl,
            `${tier.id} summer non-member nightly rate`,
            tier.nightlyRates.summer.nonMemberCents,
          ),
        },
      },
    });
  }

  return result.map((tier, index) => ({
    ...tier,
    maxAge: result[index + 1] ? result[index + 1].minAge - 1 : null,
  }));
}

async function runWizard() {
  const defaults = loadDefaultConfig();
  const rl = createInterface({ input, output });

  try {
    console.log("AlpineClubBookingsNZ setup wizard");
    console.log("This writes config/club.json only. Secrets stay in environment variables.\n");

    const name = await ask(rl, "Club name", defaults.name);
    const shortName = await ask(rl, "Short name", defaults.shortName ?? "");
    const supportEmail = await ask(rl, "Support email", defaults.supportEmail);
    const contactEmail = await ask(
      rl,
      "Bookings/contact email",
      defaults.contactEmail ?? defaults.supportEmail,
    );
    const publicUrl = (await ask(rl, "Public URL without trailing slash", defaults.publicUrl)).replace(/\/+$/, "");
    const emailFromName = await ask(
      rl,
      "Email sender display name",
      defaults.emailFromName || `${name} - Online Booking System`,
    );
    const capacity = await askInt(
      rl,
      "Total bunk/bed capacity",
      defaults.beds.reduce((total, bed) => total + bed.capacity, 0),
    );
    const ageTiers = await collectAgeTiers(rl, defaults.ageTiers);

    const nextConfig: ClubConfig = {
      ...defaults,
      name,
      shortName: shortName || undefined,
      supportEmail,
      contactEmail,
      publicUrl,
      emailFromName,
      beds: [
        {
          id: "lodge",
          name: defaults.beds[0]?.name ?? "Main Lodge",
          capacity,
          type: defaults.beds[0]?.type ?? "dormitory",
        },
      ],
      ageTiers,
    };

    const parsed = clubConfigSchema.safeParse(nextConfig);
    if (!parsed.success) {
      console.error("Config was not written because validation failed:");
      for (const issue of parsed.error.issues) {
        console.error(`- ${issue.path.join(".") || "root"}: ${issue.message}`);
      }
      process.exitCode = 1;
      return;
    }

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      CLUB_CONFIG_PATH,
      `${JSON.stringify(parsed.data, null, 2)}\n`,
      "utf8",
    );
    console.log(`\nWrote ${CLUB_CONFIG_PATH}`);

    const missingEnv = getSetupRequiredEnvNames().filter((name) => {
      if (name === "AUTH_SECRET or NEXTAUTH_SECRET") {
        return !process.env.AUTH_SECRET && !process.env.NEXTAUTH_SECRET;
      }
      return !process.env[name];
    });
    if (missingEnv.length > 0) {
      console.log("\nStill missing or unset:");
      for (const name of missingEnv) {
        console.log(`- ${name}`);
      }
    }

    console.log("\nNext steps:");
    console.log("- Set env values manually; do not commit secrets.");
    console.log("- Run npm run db:migrate && npm run db:seed.");
    console.log("- Log in as the seeded admin and finish /admin/setup and /admin/modules.");
  } finally {
    rl.close();
  }
}

function runCheck() {
  const readiness = buildSetupReadiness({
    configDir: CONFIG_DIR,
  });
  console.log(renderSetupCheckReport(readiness));
  if (readiness.status === "blocked") {
    process.exitCode = 1;
  }
}

async function main() {
  const command = process.argv[2] ?? "check";
  if (command === "check") {
    runCheck();
    return;
  }
  if (command === "wizard") {
    await runWizard();
    return;
  }

  console.error(`Unknown setup command: ${command}`);
  console.error("Usage: tsx scripts/setup.ts check|wizard");
  process.exitCode = 1;
}

void main();
