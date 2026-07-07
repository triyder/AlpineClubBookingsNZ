export const DEMO_SEED_DOMAIN = "demo.alpineclub.test";

type DemoSeedEnvironment = {
  ALLOW_DEMO_SEED?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
};

export type DemoSeedGuardOptions = {
  env: DemoSeedEnvironment;
  countNonDemoMembers: () => Promise<number>;
};

const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
}

function parseDatabaseHostname(databaseUrl: string | undefined) {
  if (!databaseUrl) {
    throw new Error(
      "Refusing to run demo seed: DATABASE_URL is missing or invalid. " +
        "Point DATABASE_URL at a disposable local PostgreSQL database first.",
    );
  }

  try {
    return normalizeHostname(new URL(databaseUrl).hostname);
  } catch {
    throw new Error(
      "Refusing to run demo seed: DATABASE_URL is missing or invalid. " +
        "Point DATABASE_URL at a disposable local PostgreSQL database first.",
    );
  }
}

export async function assertDemoSeedMayRun({ env, countNonDemoMembers }: DemoSeedGuardOptions) {
  if (env.ALLOW_DEMO_SEED !== "1") {
    throw new Error("Refusing to run demo seed: set ALLOW_DEMO_SEED=1 to opt in explicitly.");
  }

  if ((env.NODE_ENV ?? "").toLowerCase() === "production") {
    throw new Error("Refusing to run demo seed: NODE_ENV=production is not allowed.");
  }

  const hostname = parseDatabaseHostname(env.DATABASE_URL);
  if (!LOCAL_DATABASE_HOSTS.has(hostname)) {
    throw new Error(`Refusing to run demo seed: DATABASE_URL host is not local (${hostname || "unknown"}).`);
  }

  const nonDemoMemberCount = await countNonDemoMembers();
  if (nonDemoMemberCount > 0) {
    throw new Error(
      `Refusing to run demo seed: found ${nonDemoMemberCount} Member row(s) outside ` +
        `${DEMO_SEED_DOMAIN}. Use an empty or demo-only disposable database.`,
    );
  }
}
