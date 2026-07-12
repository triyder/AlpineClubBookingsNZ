import { readFileSync, readdirSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLUB_THEME_VALUES,
  TOKOROA_CLUB_THEME_VALUES,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";

const MIGRATION_SUFFIX = "_reseed_untouched_club_theme_teal";
const INITIAL_THEME_MIGRATION = "20260611123000_add_club_theme";
const GOLD_BUMP_MIGRATION = "20260705120000_bump_sub_aa_club_theme_gold";

const LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS: ClubThemeValues = {
  brandGold: "#8fa87c",
  brandCharcoal: "#30343b",
  brandDeep: "#1f2933",
  brandRidge: "#65717b",
  brandMist: "#d7dde1",
  brandSnow: "#f8faf8",
  brandSafety: "#c2562c",
  headingFontKey: "LEAGUE_SPARTAN",
  bodyFontKey: "INTER",
  logoDataUrl: null,
  rawCss: "",
};

type StoredTheme = ClubThemeValues & {
  id: string;
  completedAt: Date | null;
};

function migrationSql(name: string) {
  return readFileSync(
    path.resolve(process.cwd(), "prisma/migrations", name, "migration.sql"),
    "utf8",
  );
}

function correctiveMigrationSql() {
  const migrationsDir = path.resolve(process.cwd(), "prisma/migrations");
  const migration = readdirSync(migrationsDir).find((name) =>
    name.endsWith(MIGRATION_SUFFIX),
  );
  if (!migration) {
    throw new Error(`Could not find migration ending in ${MIGRATION_SUFFIX}`);
  }
  return migrationSql(migration);
}

function matchesCorrectiveGuard(row: StoredTheme) {
  return (
    row.id === "default" &&
    row.completedAt === null &&
    Object.entries(LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS).every(
      ([key, value]) => row[key as keyof ClubThemeValues] === value,
    )
  );
}

function applyCorrectiveMigration(row: StoredTheme): StoredTheme {
  return matchesCorrectiveGuard(row)
    ? { ...row, ...DEFAULT_CLUB_THEME_VALUES }
    : { ...row };
}

describe("untouched ClubTheme teal corrective migration (#1832)", () => {
  const sql = correctiveMigrationSql();
  const executable = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  it("pins the legacy guard to the state produced by the prior migration chain", () => {
    const initialSql = migrationSql(INITIAL_THEME_MIGRATION);
    const goldBumpSql = migrationSql(GOLD_BUMP_MIGRATION);

    expect(initialSql).toContain("ELSE '#7a8f6a' END");
    expect(goldBumpSql).toContain(
      `SET "brandGold"     = '${LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS.brandGold}' WHERE "brandGold"     = '#7a8f6a'`,
    );
    for (const [field, value] of Object.entries(
      LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS,
    )) {
      if (value === null) {
        expect(sql).toContain(`"${field}" IS NULL`);
      } else if (field.endsWith("FontKey")) {
        expect(sql).toContain(
          `"${field}" = '${value}'::"ClubThemeFont"`,
        );
      } else {
        expect(sql).toContain(`"${field}" = '${value}'`);
      }
    }
  });

  it("updates an untouched incomplete legacy sage theme to every current teal default", () => {
    const legacy: StoredTheme = {
      id: "default",
      completedAt: null,
      ...LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS,
    };

    expect(applyCorrectiveMigration(legacy)).toEqual({
      id: "default",
      completedAt: null,
      ...DEFAULT_CLUB_THEME_VALUES,
    });
    for (const [field, value] of Object.entries(DEFAULT_CLUB_THEME_VALUES)) {
      if (value === null) {
        continue;
      }
      expect(sql).toContain(`"${field}" = '${value}'`);
    }
  });

  it("leaves a completed legacy theme unchanged", () => {
    const completed: StoredTheme = {
      id: "default",
      completedAt: new Date("2026-07-01T00:00:00.000Z"),
      ...LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS,
    };

    expect(applyCorrectiveMigration(completed)).toEqual(completed);
    expect(sql).toContain('"completedAt" IS NULL');
  });

  it("leaves an incomplete, partially customized theme unchanged", () => {
    const customized: StoredTheme = {
      id: "default",
      completedAt: null,
      ...LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS,
      brandMist: "#abcdef",
    };

    expect(applyCorrectiveMigration(customized)).toEqual(customized);
  });

  it("leaves an existing Tokoroa theme unchanged even if completion metadata is absent", () => {
    const tokoroa: StoredTheme = {
      id: "default",
      completedAt: null,
      ...TOKOROA_CLUB_THEME_VALUES,
    };

    expect(applyCorrectiveMigration(tokoroa)).toEqual(tokoroa);
  });

  it("is idempotent and data-only", () => {
    const legacy: StoredTheme = {
      id: "default",
      completedAt: null,
      ...LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS,
    };
    const once = applyCorrectiveMigration(legacy);

    expect(applyCorrectiveMigration(once)).toEqual(once);
    expect(executable.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(executable).not.toMatch(/\b(ALTER|CREATE|DELETE|DROP|INSERT|TRUNCATE)\b/i);
    expect(executable).toContain('UPDATE "ClubTheme"');
    expect(executable).toContain('WHERE "id" = \'default\'');
  });
});
