/**
 * #4367: realdb files take turns on the shared race database. The parallel
 * failures and their absence under the lock were measured against PostgreSQL
 * (see the PR); this pins the lock's contract without one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  REALDB_FILE_LOCK_KEY,
  REALDB_FILE_WAIT_TIMEOUT,
  acquireRealdbFileLock,
  isRealdbTestFile,
  serialiseRealdbFile,
  type RealdbLockClient,
} from "./support/realdb-file-serialisation";
import { stripComments } from "./support/strip-comments";

const pgClients = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("pg", () => ({
  Client: class {
    constructor(config: Record<string, unknown>) {
      pgClients.push(config);
    }
    on() {}
    async connect() {}
    async query() {
      return { rows: [{ locked: true }] };
    }
    async end() {}
  },
}));

const RACE_URL = "postgresql://postgres:postgres@127.0.0.1:55767/concurrency_race_1881";
const REALDB_FILE = "/repo/src/lib/__tests__/xero-refund-note-void-pointer.realdb.test.ts";

function fakeClient(tryResults: boolean[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const events: string[] = [];
  const errorListeners: Array<(error: Error) => void> = [];
  const client: RealdbLockClient = {
    on(_event, listener) {
      errorListeners.push(listener);
    },
    async connect() {
      events.push("connect");
    },
    async query<R extends Record<string, unknown>>(text: string, values: unknown[]) {
      calls.push({ text, values });
      if (!text.includes("unlock")) {
        return { rows: [{ locked: tryResults.shift() ?? true }] as unknown as R[] };
      }
      return { rows: [] as R[] };
    },
    async end() {
      events.push("end");
    },
  };
  return { client, calls, events, errorListeners };
}

describe("realdb file serialisation (#4367)", () => {
  it("applies to realdb test files only", () => {
    expect(isRealdbTestFile(REALDB_FILE)).toBe(true);
    expect(isRealdbTestFile("/repo/src/lib/__tests__/foo.realdb.test.tsx")).toBe(true);
    expect(isRealdbTestFile("/repo/src/lib/__tests__/foo-realdb-wiring.test.ts")).toBe(false);
    expect(isRealdbTestFile("/repo/src/lib/__tests__/foo.test.ts")).toBe(false);
    expect(isRealdbTestFile(undefined)).toBe(false);
  });

  it("uses a two-int key, never the global cohort key 1", () => {
    // The single-argument form of key 1 is `pg_advisory_xact_lock(1)`, which
    // suites count in pg_locks; the two-int form lives under objsubid 2.
    expect(REALDB_FILE_LOCK_KEY).toEqual([4367, 1]);
  });

  it("opens no connection for a non-realdb file or without a race URL", async () => {
    const connect = () => {
      throw new Error("must not connect");
    };
    await expect(acquireRealdbFileLock("/repo/foo.test.ts", RACE_URL, connect)).resolves.toBeNull();
    await expect(acquireRealdbFileLock(REALDB_FILE, "", connect)).resolves.toBeNull();
  });

  it("refuses an unsafe database before connecting", async () => {
    const connect = () => {
      throw new Error("must not connect");
    };
    await expect(
      acquireRealdbFileLock(REALDB_FILE, "postgresql://u:p@127.0.0.1:5432/concurrency_race_1881", connect),
    ).rejects.toThrow(/never 5432/);
  });

  it("polls with the non-blocking try-lock until its turn, then releases and disconnects", async () => {
    const fake = fakeClient([false, false, true]);
    let pauses = 0;
    const release = await acquireRealdbFileLock(REALDB_FILE, RACE_URL, () => fake.client, async () => {
      pauses += 1;
    });

    expect(pauses).toBe(2);
    expect(fake.calls).toHaveLength(3);
    for (const call of fake.calls) {
      // A blocking pg_advisory_lock would show the waiter as an ungranted
      // advisory row, which several suites' barriers count.
      expect(call.text).toBe("SELECT pg_try_advisory_lock($1, $2) AS locked");
      expect(call.values).toEqual([4367, 1]);
    }
    expect(fake.events).toEqual(["connect"]);

    expect(release).not.toBeNull();
    await release?.();
    expect(fake.calls.at(-1)).toEqual({
      text: "SELECT pg_advisory_unlock($1, $2)",
      values: [4367, 1],
    });
    expect(fake.events).toEqual(["connect", "end"]);
  });

  it("disconnects when taking the lock fails", async () => {
    const fake = fakeClient([]);
    fake.client.query = async () => {
      throw new Error("connection reset");
    };
    await expect(acquireRealdbFileLock(REALDB_FILE, RACE_URL, () => fake.client)).rejects.toThrow(
      "connection reset",
    );
    expect(fake.events).toEqual(["connect", "end"]);
  });

  it("names a dropped lock connection at release instead of crashing the worker", async () => {
    const fake = fakeClient([true]);
    const release = await acquireRealdbFileLock(REALDB_FILE, RACE_URL, () => fake.client);
    expect(fake.errorListeners).toHaveLength(1);
    fake.errorListeners[0]?.(new Error("Connection terminated unexpectedly"));
    await expect(release?.()).rejects.toThrow(/#4367: the realdb file lock's connection dropped/);
    expect(fake.events).toEqual(["connect", "end"]);
  });

  it("wraps the whole file in one aroundAll with no timeout, reading the race URL and the file path", async () => {
    let registered: ((runSuite: () => Promise<void>) => Promise<void>) | undefined;
    let timeout: number | undefined;
    const acquired: Array<[string | undefined, string]> = [];
    const order: string[] = [];
    serialiseRealdbFile({
      aroundAll: (fn, ms) => {
        registered = fn;
        timeout = ms;
      },
      testPath: () => REALDB_FILE,
      raceDatabaseUrl: () => RACE_URL,
      acquire: async (testPath, url) => {
        acquired.push([testPath, url]);
        order.push("acquire");
        return async () => {
          order.push("release");
        };
      },
    });
    expect(timeout).toBe(REALDB_FILE_WAIT_TIMEOUT);
    expect(REALDB_FILE_WAIT_TIMEOUT).toBe(0);

    // A failing file (e.g. a root afterAll guard throwing) still releases.
    await expect(
      registered?.(async () => {
        order.push("suite");
        throw new Error("outbox guard");
      }),
    ).rejects.toThrow("outbox guard");
    expect(acquired).toEqual([[REALDB_FILE, RACE_URL]]);
    expect(order).toEqual(["acquire", "suite", "release"]);
  });

  it("reads the race URL from CONCURRENCY_RACE_DATABASE_URL by default", () => {
    const source = stripComments(
      readFileSync(path.join(process.cwd(), "src/lib/__tests__/support/realdb-file-serialisation.ts"), "utf8"),
    );
    expect(source).toContain('raceDatabaseUrl: () => process.env.CONCURRENCY_RACE_DATABASE_URL ?? ""');
    expect(source).toContain("testPath: () => expect.getState().testPath");
  });

  it("bounds each lock query by default, though the wait itself is unbounded", async () => {
    const release = await acquireRealdbFileLock(REALDB_FILE, RACE_URL);
    await release?.();
    expect(pgClients).toEqual([{ connectionString: RACE_URL, query_timeout: 30_000 }]);
  });

  it("is registered by vitest.setup.ts whenever the race env is on", () => {
    const setup = stripComments(readFileSync(path.join(process.cwd(), "vitest.setup.ts"), "utf8"));
    expect(setup).toMatch(
      /if \(process\.env\.RUN_CONCURRENCY_RACE_TESTS === "1"\) \{\s*const \{ serialiseRealdbFile \} = await import\(\s*"\.\/src\/lib\/__tests__\/support\/realdb-file-serialisation"\s*\);\s*serialiseRealdbFile\(\);\s*\}/,
    );
  });
});
