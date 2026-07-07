import { describe, expect, it, vi } from "vitest";
import { assertDemoSeedMayRun } from "@/lib/demo-seed-guard";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    ALLOW_DEMO_SEED: "1",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/demo",
    NODE_ENV: "development",
    ...overrides,
  };
}

async function expectAllowed(overrides: Record<string, string | undefined> = {}) {
  const countNonDemoMembers = vi.fn(async () => 0);

  await expect(
    assertDemoSeedMayRun({
      env: env(overrides),
      countNonDemoMembers,
    }),
  ).resolves.toBeUndefined();

  expect(countNonDemoMembers).toHaveBeenCalledTimes(1);
}

async function expectRefused(
  overrides: Record<string, string | undefined>,
  message: string | RegExp,
  nonDemoCount = 0,
) {
  const countNonDemoMembers = vi.fn(async () => nonDemoCount);

  await expect(
    assertDemoSeedMayRun({
      env: env(overrides),
      countNonDemoMembers,
    }),
  ).rejects.toThrow(message);

  return countNonDemoMembers;
}

describe("demo seed production guard", () => {
  it("allows explicitly opted-in local demo-only databases", async () => {
    await expectAllowed();
    await expectAllowed({ DATABASE_URL: "postgresql://user:pass@127.0.0.1:5432/demo" });
    await expectAllowed({ DATABASE_URL: "postgresql://user:pass@[::1]:5432/demo", NODE_ENV: undefined });
  });

  it("requires ALLOW_DEMO_SEED=1 before reading the database", async () => {
    const missing = await expectRefused({ ALLOW_DEMO_SEED: undefined }, "ALLOW_DEMO_SEED=1");
    expect(missing).not.toHaveBeenCalled();

    const wrongValue = await expectRefused({ ALLOW_DEMO_SEED: "true" }, "ALLOW_DEMO_SEED=1");
    expect(wrongValue).not.toHaveBeenCalled();
  });

  it("refuses production before reading the database", async () => {
    const countNonDemoMembers = await expectRefused(
      { NODE_ENV: "production" },
      "NODE_ENV=production",
    );

    expect(countNonDemoMembers).not.toHaveBeenCalled();
  });

  it("refuses missing, invalid, or non-local DATABASE_URL before reading the database", async () => {
    const missing = await expectRefused({ DATABASE_URL: undefined }, "DATABASE_URL is missing or invalid");
    expect(missing).not.toHaveBeenCalled();

    const invalid = await expectRefused({ DATABASE_URL: "not a url" }, "DATABASE_URL is missing or invalid");
    expect(invalid).not.toHaveBeenCalled();

    const remote = await expectRefused(
      { DATABASE_URL: "postgresql://user:pass@db.example.org:5432/demo" },
      "DATABASE_URL host is not local (db.example.org)",
    );
    expect(remote).not.toHaveBeenCalled();
  });

  it("refuses a local database that already has non-demo members", async () => {
    const countNonDemoMembers = await expectRefused(
      {},
      /found 2 Member row\(s\) outside demo\.alpineclub\.test/,
      2,
    );

    expect(countNonDemoMembers).toHaveBeenCalledTimes(1);
  });
});
