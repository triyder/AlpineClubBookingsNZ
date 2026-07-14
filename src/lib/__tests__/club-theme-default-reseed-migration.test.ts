import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_CLUB_THEME_VALUES,
  TOKOROA_CLUB_THEME_VALUES,
  type ClubThemeValues,
} from "@/lib/club-theme-schema";

const databaseUrl = process.env.CLUB_THEME_MIGRATION_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

const MIGRATION_SUFFIX = "_reseed_untouched_club_theme_teal";
const INITIAL_THEME_MIGRATION = "20260611123000_add_club_theme";
const RAW_CSS_MIGRATION = "20260614100000_add_club_theme_raw_css";
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

const THEME_SELECT = `
  "id",
  "brandGold",
  "brandCharcoal",
  "brandDeep",
  "brandRidge",
  "brandMist",
  "brandSnow",
  "brandSafety",
  "headingFontKey"::text AS "headingFontKey",
  "bodyFontKey"::text AS "bodyFontKey",
  "logoDataUrl",
  "rawCss",
  "completedAt"
`;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

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

async function readTheme(client: Client, id = "default") {
  const result = await client.query<StoredTheme>(
    `SELECT ${THEME_SELECT} FROM "ClubTheme" WHERE "id" = $1`,
    [id],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0];
}

async function replaceDefaultTheme(
  client: Client,
  values: ClubThemeValues,
  completedAt: Date | null,
) {
  await client.query(
    `
      UPDATE "ClubTheme"
      SET
        "brandGold" = $1,
        "brandCharcoal" = $2,
        "brandDeep" = $3,
        "brandRidge" = $4,
        "brandMist" = $5,
        "brandSnow" = $6,
        "brandSafety" = $7,
        "headingFontKey" = $8::"ClubThemeFont",
        "bodyFontKey" = $9::"ClubThemeFont",
        "logoDataUrl" = $10,
        "rawCss" = $11,
        "completedAt" = $12
      WHERE "id" = 'default'
    `,
    [
      values.brandGold,
      values.brandCharcoal,
      values.brandDeep,
      values.brandRidge,
      values.brandMist,
      values.brandSnow,
      values.brandSafety,
      values.headingFontKey,
      values.bodyFontKey,
      values.logoDataUrl,
      values.rawCss,
      completedAt,
    ],
  );
}

async function withThemeMigrationSchema(
  run: (client: Client, correctiveSql: string) => Promise<void>,
) {
  const schemaName = `club_theme_reseed_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    // The initial ClubTheme migration only uses Member to distinguish an
    // existing deployment from a fresh generic install. An empty table follows
    // the untouched generic-install branch without replaying unrelated schema.
    await client.query('CREATE TABLE "Member" ("id" TEXT PRIMARY KEY)');
    await client.query(migrationSql(INITIAL_THEME_MIGRATION));
    await client.query(migrationSql(RAW_CSS_MIGRATION));
    await client.query(migrationSql(GOLD_BUMP_MIGRATION));

    await run(client, correctiveMigrationSql());
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

describe("untouched ClubTheme teal corrective migration source contract (#1832)", () => {
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

  it("sets every current teal colour and remains data-only", () => {
    for (const field of [
      "brandGold",
      "brandCharcoal",
      "brandDeep",
      "brandRidge",
      "brandMist",
      "brandSnow",
      "brandSafety",
    ] as const) {
      expect(sql).toContain(
        `"${field}" = '${DEFAULT_CLUB_THEME_VALUES[field]}'`,
      );
    }
    expect(executable.match(/\bUPDATE\b/g)).toHaveLength(1);
    expect(executable).not.toMatch(
      /\b(ALTER|CREATE|DELETE|DROP|INSERT|TRUNCATE)\b/i,
    );
    expect(executable).toContain('UPDATE "ClubTheme"');
    expect(executable).toContain('WHERE "id" = \'default\'');
  });
});

describeWithDatabase("untouched ClubTheme teal corrective migration PostgreSQL behavior (#1832)", () => {
  it("updates the untouched legacy theme after the full relevant lineage", async () => {
    await withThemeMigrationSchema(async (client, correctiveSql) => {
      expect(await readTheme(client)).toMatchObject({
        id: "default",
        completedAt: null,
        ...LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS,
      });

      await client.query(correctiveSql);

      expect(await readTheme(client)).toMatchObject({
        id: "default",
        completedAt: null,
        ...DEFAULT_CLUB_THEME_VALUES,
      });
    });
  });

  it("leaves a completed legacy theme unchanged", async () => {
    await withThemeMigrationSchema(async (client, correctiveSql) => {
      const completedAt = new Date("2026-07-01T00:00:00.000Z");
      await replaceDefaultTheme(
        client,
        LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS,
        completedAt,
      );
      const before = await readTheme(client);

      await client.query(correctiveSql);

      expect(await readTheme(client)).toEqual(before);
    });
  });

  it("leaves an incomplete partially customized theme unchanged", async () => {
    await withThemeMigrationSchema(async (client, correctiveSql) => {
      await replaceDefaultTheme(
        client,
        { ...LEGACY_SAGE_AFTER_PRIOR_MIGRATIONS, brandMist: "#abcdef" },
        null,
      );
      const before = await readTheme(client);

      await client.query(correctiveSql);

      expect(await readTheme(client)).toEqual(before);
    });
  });

  it("leaves an existing Tokoroa theme unchanged", async () => {
    await withThemeMigrationSchema(async (client, correctiveSql) => {
      // Keep completedAt null deliberately so the palette guard, not only the
      // completion guard, proves Tokoroa data is excluded.
      await replaceDefaultTheme(client, TOKOROA_CLUB_THEME_VALUES, null);
      const before = await readTheme(client);

      await client.query(correctiveSql);

      expect(await readTheme(client)).toEqual(before);
    });
  });

  it("leaves a non-default untouched legacy row unchanged", async () => {
    await withThemeMigrationSchema(async (client, correctiveSql) => {
      await client.query(`
        INSERT INTO "ClubTheme" (
          "id", "brandGold", "brandCharcoal", "brandDeep", "brandRidge",
          "brandMist", "brandSnow", "brandSafety", "headingFontKey",
          "bodyFontKey", "logoDataUrl", "rawCss", "completedAt"
        )
        SELECT
          'secondary', "brandGold", "brandCharcoal", "brandDeep", "brandRidge",
          "brandMist", "brandSnow", "brandSafety", "headingFontKey",
          "bodyFontKey", "logoDataUrl", "rawCss", "completedAt"
        FROM "ClubTheme" WHERE "id" = 'default'
      `);
      const before = await readTheme(client, "secondary");

      await client.query(correctiveSql);

      expect(await readTheme(client, "secondary")).toEqual(before);
      expect(await readTheme(client)).toMatchObject(DEFAULT_CLUB_THEME_VALUES);
    });
  });

  it("is idempotent when the actual SQL executes a second time", async () => {
    await withThemeMigrationSchema(async (client, correctiveSql) => {
      await client.query(correctiveSql);
      const afterFirstRun = await readTheme(client);

      const secondRun = await client.query(correctiveSql);

      expect(secondRun.rowCount).toBe(0);
      expect(await readTheme(client)).toEqual(afterFirstRun);
    });
  });
});
