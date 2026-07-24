import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

/**
 * MP1 (#189), epic #171 — guards the member-photos schema foundation and its
 * expand-only migration so a later refactor cannot silently weaken the storage
 * model, the CONTENT default, or the safety shape of the migration.
 */

const schemaText = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
);

const MIGRATION_DIR = "20260721110000_add_member_photos";
const migrationSql = readFileSync(
  join(process.cwd(), "prisma", "migrations", MIGRATION_DIR, "migration.sql"),
  "utf8",
);

describe("member-photos schema", () => {
  it("defines the MediaImageKind enum with CONTENT and MEMBER_PHOTO", () => {
    const enumBlock = schemaText.match(/enum MediaImageKind \{([^}]*)\}/);
    expect(enumBlock, "MediaImageKind enum is missing").not.toBeNull();
    expect(enumBlock![1]).toContain("CONTENT");
    expect(enumBlock![1]).toContain("MEMBER_PHOTO");
  });

  it("defaults MediaImage.kind to CONTENT so existing rows stay in the picker", () => {
    expect(schemaText).toMatch(
      /kind\s+MediaImageKind\s+@default\(CONTENT\)/,
    );
  });

  it("stores the photo on Member via a nullable FK with onDelete: SetNull", () => {
    expect(schemaText).toMatch(/photoImageId\s+String\?/);
    expect(schemaText).toMatch(
      /photoImage\s+MediaImage\?\s+@relation\("MemberPhoto", fields: \[photoImageId\], references: \[id\], onDelete: SetNull\)/,
    );
  });

  it("carries the photo audit snapshot columns", () => {
    expect(schemaText).toMatch(/photoUpdatedAt\s+DateTime\?/);
    expect(schemaText).toMatch(/photoUpdatedByMemberId\s+String\?/);
  });

  it("indexes the picker filter and member-photo lookups", () => {
    expect(schemaText).toMatch(/@@index\(\[kind\]\)/);
    expect(schemaText).toMatch(/@@index\(\[photoImageId\]\)/);
  });
});

describe("member-photos migration is expand-only", () => {
  it("has a unique, non-colliding 14-digit migration timestamp", () => {
    // The migration was appended after the wave/upstream-sync history at
    // creation time; it need not remain the newest (later member-photos-epic
    // migrations, e.g. the committee-photo-display setting, legitimately sort
    // after it). The durable safety property is a unique timestamp — no other
    // migration shares its 14-digit prefix, so apply order is unambiguous.
    const names = readdirSync(join(process.cwd(), "prisma", "migrations"), {
      withFileTypes: true,
    })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => /^\d{14}_/.test(n));
    expect(names).toContain(MIGRATION_DIR);
    const prefix = MIGRATION_DIR.slice(0, 14);
    const collisions = names.filter(
      (n) => n !== MIGRATION_DIR && n.slice(0, 14) === prefix,
    );
    expect(collisions).toEqual([]);
  });

  it("only adds — no DROP/DELETE/TRUNCATE and no NOT NULL backfill risk", () => {
    expect(migrationSql).toMatch(/CREATE TYPE "MediaImageKind"/);
    expect(migrationSql).toMatch(/ADD COLUMN\s+"photoImageId" TEXT/);
    expect(migrationSql).toMatch(
      /ADD COLUMN\s+"kind" "MediaImageKind" NOT NULL DEFAULT 'CONTENT'/,
    );
    expect(migrationSql).toMatch(/ON DELETE SET NULL/);
    // Strip SQL comments before scanning for destructive statements so the
    // documentation header can freely explain what is NOT done.
    const executable = migrationSql
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE|CONSTRAINT|INDEX)/i);
    expect(executable).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
    // The only NOT NULL column added carries a constant default (metadata-only).
    expect(executable).not.toMatch(/ADD COLUMN\s+"photoImageId" TEXT NOT NULL/);
  });
});
