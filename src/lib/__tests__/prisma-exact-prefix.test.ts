import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exactContains, exactPrefix } from "@/lib/prisma-exact-prefix";

const REPO_ROOT = resolve(__dirname, "../../..");

describe("exactPrefix (#4146)", () => {
  it("escapes the three LIKE metacharacters with a backslash and nothing else", () => {
    expect(exactPrefix("duplicate_capture_b1_")).toEqual({ startsWith: "duplicate\\_capture\\_b1\\_" });
    expect(exactPrefix("a%b\\c")).toEqual({ startsWith: "a\\%b\\\\c" });
    expect(exactPrefix("payment:cm1abc:refund-credit-note:")).toEqual({ startsWith: "payment:cm1abc:refund-credit-note:" });
  });

  it("escapes a contains operand the same way (#4165)", () => {
    expect(exactContains("DATA_EXPORT")).toEqual({ contains: "DATA\\_EXPORT" });
    expect(exactContains("a%b\\c")).toEqual({ contains: "a\\%b\\\\c" });
    expect(exactContains("data-export")).toEqual({ contains: "data-export" });
  });

  it.each(["", "John_Smith", "100%", "folder\\name", "a_%\\b"])(
    "preserves insensitive mode while escaping %j (#4190)",
    (value) => {
      expect(exactContains(value, "insensitive")).toEqual({
        ...exactContains(value), mode: "insensitive",
      });
    },
  );

  it("stays wired into the race harness CI runs against a real database", () => {
    // The PostgreSQL proof self-skips without the race flag; hosted CI reaches
    // it only through the harness's import.
    const harness = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/concurrency-lock-races.realdb.test.ts"), "utf8");
    expect(harness).toContain('import "./prisma-exact-prefix.realdb.test";');
    const suite = readFileSync(resolve(REPO_ROOT, "src/lib/__tests__/prisma-exact-prefix.realdb.test.ts"), "utf8");
    expect(suite).toContain('process.env.RUN_CONCURRENCY_RACE_TESTS === "1"');
    expect(suite).toContain("CONTRAST: Prisma's bare startsWith still reads `_` as a wildcard");
  });
});
