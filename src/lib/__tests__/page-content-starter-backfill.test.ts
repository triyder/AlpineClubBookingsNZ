import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { starterPageContent } from "../../../prisma/starter-page-content";

// Production deploys run Prisma migrations but not the seed, so the starter
// PageContent rows are backfilled by a data migration. These tests keep that
// SQL in sync with starterPageContent: if a starter page is added or edited
// without a matching backfill migration, deploy-only environments would 404
// the affected public route or keep stale default copy.
const INSERT_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260611101500_backfill_starter_page_content",
  "migration.sql",
);

const BACKFILL_404_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260614110000_backfill_404_page_content",
  "migration.sql",
);

const POLICY_PAGES_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260702090000_backfill_policy_page_content",
  "migration.sql",
);

const HOME_UPDATE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260613090000_update_starter_home_page_content",
  "migration.sql",
);

const FAQ_UPDATE_MIGRATION_PATH = join(
  process.cwd(),
  "prisma",
  "migrations",
  "20260702120000_update_starter_faq_accordion",
  "migration.sql",
);

// Previous starter FAQ contentHtml (flat <h3>/<p> pairs), replaced by the
// accordion update migration. Extracted verbatim from the policy-pages
// backfill so the update migration's WHERE guard provably matches what that
// backfill wrote; rows edited by an admin since then are left untouched.
function previousFaqContentHtml(policyPagesSql: string) {
  const faqBlock = policyPagesSql
    .split("'starter-page-faq'")[1]
    ?.match(/\$cms\$([\s\S]*?)\$cms\$/)?.[1];
  if (!faqBlock) {
    throw new Error("FAQ contentHtml not found in policy pages backfill SQL");
  }
  return faqBlock;
}

// Previous default "home" copy, replaced by the update migration above. The
// update migration's WHERE clause must guard on these values so deployments
// where an admin has already edited the home page are left untouched.
const PREVIOUS_HOME_CONTENT = {
  caption: "Whakapapa, Mt Ruapehu",
  title: "Mt Ruapehu Lodge",
  headerText:
    "Our club lodge sits in the Whakapapa ski area on Mt Ruapehu. Book a stay, join the club, and explore New Zealand's mountains.",
};

function sqlQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function expectSqlContainsValue(sql: string, value: string) {
  expect(
    sql.includes(sqlQuote(value)) || sql.includes(value),
    `expected backfill SQL to contain ${value}`,
  ).toBe(true);
}

describe("starter page content backfill migration", () => {
  const insertSql = readFileSync(INSERT_MIGRATION_PATH, "utf8");
  const backfill404Sql = readFileSync(BACKFILL_404_MIGRATION_PATH, "utf8");
  const policyPagesSql = readFileSync(POLICY_PAGES_MIGRATION_PATH, "utf8");
  const updateSql = readFileSync(HOME_UPDATE_MIGRATION_PATH, "utf8");
  const faqUpdateSql = readFileSync(FAQ_UPDATE_MIGRATION_PATH, "utf8");
  const allInsertSql = `${insertSql}\n${backfill404Sql}\n${policyPagesSql}`;
  const combinedSql = `${allInsertSql}\n${updateSql}\n${faqUpdateSql}`;

  it("inserts exactly the starter pages defined for the seed", () => {
    const insertedIds = [
      ...allInsertSql.matchAll(/'starter-page-([a-z0-9-]+)'/g),
    ].map((match) => match[1]);
    const expectedIds = starterPageContent.map((page) =>
      page.slug.replace(/\//g, "-"),
    );
    expect(insertedIds.sort()).toEqual(expectedIds.sort());
  });

  it("matches every current seed value so edited seeds force a new backfill", () => {
    for (const page of starterPageContent) {
      const fields = [
        page.slug,
        page.path,
        page.caption,
        page.menuTitle,
        page.title,
        page.headerText,
        page.contentHtml,
      ].filter((value) => value !== "");
      for (const value of fields) {
        expectSqlContainsValue(combinedSql, value);
      }
      expect(combinedSql).toContain(`${page.sortOrder},`);
    }
  });

  it("never overwrites existing rows in the initial backfill", () => {
    expect(allInsertSql).toContain("ON CONFLICT DO NOTHING");
    expect(allInsertSql).not.toMatch(/DO UPDATE/i);
    expect(allInsertSql).not.toMatch(/\b(UPDATE|DELETE)\b/);
  });

  it("covers the routes that hard-404 without a record", () => {
    // "/" renders the "/home" record and the footer/sitemap link to "/rules";
    // both must exist after migrations alone.
    expect(insertSql).toContain("'/home'");
    expect(insertSql).toContain("'/rules'");
    expect(policyPagesSql).toContain("'/privacy'");
    expect(policyPagesSql).toContain("'/terms'");
    expect(policyPagesSql).toContain("'/faq'");
  });
});

describe("starter home page content update migration", () => {
  const sql = readFileSync(HOME_UPDATE_MIGRATION_PATH, "utf8");

  it("only updates the home row, and never inserts or deletes", () => {
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("guards the update on the row still holding the previous default text", () => {
    expect(sql).toContain(`"slug" = ${sqlQuote("home")}`);
    for (const value of Object.values(PREVIOUS_HOME_CONTENT)) {
      expect(sql, `expected WHERE clause to guard on ${value}`).toContain(
        sqlQuote(value),
      );
    }
  });

  it("writes the current club-agnostic copy from starterPageContent", () => {
    const home = starterPageContent.find((page) => page.slug === "home");
    expect(home).toBeDefined();
    for (const value of [home!.caption, home!.title, home!.headerText]) {
      expect(sql).toContain(sqlQuote(value));
    }
  });
});

describe("starter faq accordion update migration (#992)", () => {
  const sql = readFileSync(FAQ_UPDATE_MIGRATION_PATH, "utf8");
  const policyPagesSql = readFileSync(POLICY_PAGES_MIGRATION_PATH, "utf8");

  it("only updates the faq row, and never inserts or deletes", () => {
    expect(sql).toMatch(/UPDATE\s+"PageContent"/);
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });

  it("guards the update on the row still holding the backfilled flat FAQ html", () => {
    expect(sql).toContain(`"slug" = ${sqlQuote("faq")}`);
    expect(sql).toContain(previousFaqContentHtml(policyPagesSql));
  });

  it("writes the current accordion contentHtml from starterPageContent", () => {
    const faq = starterPageContent.find((page) => page.slug === "faq");
    expect(faq).toBeDefined();
    expect(sql).toContain(faq!.contentHtml);
    expect(sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');

    // SET (new accordion value) must come before the WHERE guard (old value),
    // so the two blobs are not accidentally swapped.
    const setIndex = sql.indexOf(faq!.contentHtml);
    const whereIndex = sql.indexOf(previousFaqContentHtml(policyPagesSql));
    expect(setIndex).toBeGreaterThan(-1);
    expect(whereIndex).toBeGreaterThan(setIndex);

    // The rewrap is structural only: stripping tags must leave the question
    // and answer text identical to the pre-accordion starter content.
    const stripTags = (html: string) =>
      html
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    expect(stripTags(faq!.contentHtml)).toBe(
      stripTags(previousFaqContentHtml(policyPagesSql)),
    );
  });
});
