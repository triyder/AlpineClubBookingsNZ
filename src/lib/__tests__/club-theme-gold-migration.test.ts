import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// #1244: freeze the one-time, idempotent, data-only migration that bumps any
// persisted ClubTheme colour still holding the sub-AA default gold #7a8f6a to
// the AA-compliant #8fa87c. Source-text regression (no DB): asserts the SQL is
// guarded, covers every colour column, and touches nothing but ClubTheme.

const MIGRATION_SUFFIX = "_bump_sub_aa_club_theme_gold";
const OLD_GOLD = "#7a8f6a";
const NEW_GOLD = "#8fa87c";
const COLOUR_COLUMNS = [
  "brandGold",
  "brandCharcoal",
  "brandDeep",
  "brandRidge",
  "brandMist",
  "brandSnow",
  "brandSafety",
] as const;

function readMigrationSql() {
  const migrationsDir = path.resolve(process.cwd(), "prisma/migrations");
  const dir = readdirSync(migrationsDir).find((name) =>
    name.endsWith(MIGRATION_SUFFIX),
  );
  if (!dir) {
    throw new Error(`Could not find migration ending in ${MIGRATION_SUFFIX}`);
  }
  return readFileSync(
    path.join(migrationsDir, dir, "migration.sql"),
    "utf8",
  );
}

describe("club theme sub-AA gold bump migration (#1244)", () => {
  const sql = readMigrationSql();
  // Executable SQL only: strip comment lines before splitting into statements.
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  const statements = executable
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  it("bumps the old sub-AA gold to the compliant value", () => {
    expect(sql).toContain(OLD_GOLD);
    expect(sql).toContain(NEW_GOLD);
    // Every colour column is migrated to the new value.
    for (const column of COLOUR_COLUMNS) {
      expect(executable).toMatch(
        new RegExp(`SET\\s+"${column}"\\s*=\\s*'${NEW_GOLD}'`),
      );
    }
    expect(statements).toHaveLength(COLOUR_COLUMNS.length);
  });

  it("is idempotent: every UPDATE is guarded on the old value", () => {
    // Re-running is a no-op once no row holds #7a8f6a.
    for (const column of COLOUR_COLUMNS) {
      expect(sql).toMatch(
        new RegExp(`WHERE\\s+"${column}"\\s*=\\s*'${OLD_GOLD}'`),
      );
    }
    // No UPDATE lacks a WHERE guard.
    for (const statement of statements) {
      expect(statement.toUpperCase()).toContain("WHERE");
    }
  });

  it("is data-only and touches nothing but ClubTheme", () => {
    for (const statement of statements) {
      expect(statement.toUpperCase().startsWith("UPDATE")).toBe(true);
      expect(statement).toContain('"ClubTheme"');
    }
    // No DDL or other destructive/insert verbs sneak in.
    const forbidden = [
      "DROP",
      "ALTER",
      "DELETE",
      "INSERT",
      "CREATE",
      "TRUNCATE",
    ];
    const upper = executable.toUpperCase();
    for (const verb of forbidden) {
      expect(upper).not.toContain(verb);
    }
    // The only quoted table identifier is ClubTheme.
    const tableIdentifiers = [...executable.matchAll(/UPDATE\s+"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(new Set(tableIdentifiers)).toEqual(new Set(["ClubTheme"]));
  });
});
