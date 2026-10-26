import type { DataMigrationVerification } from "./types";

/**
 * #3806 release R2 (owner decisions D1 and D2, 6 Oct 2026): the Xero refresh
 * lease and the "is Xero connected" truth move to `XeroConnection`, a one-row
 * table holding no secret. The migration backfills it from `XeroToken` and
 * installs a statement trigger that keeps it in step with `XeroToken` whoever
 * writes that table, because the previous release (#3454) can still run beside
 * this one and writes only `XeroToken`.
 *
 * What must hold:
 *   - an install connected before the release reads as connected afterwards,
 *     with the same tenant and expiry, and its token ciphertext untouched;
 *   - with two `XeroToken` rows, the most recently written one wins, as it does
 *     for the application's `XERO_TOKEN_ROW_ORDER`;
 *   - the old release's connect, refresh, reconnect, disconnect and a TRUNCATE
 *     are all reflected;
 *   - the new release's lease column is never written by the trigger, and a
 *     write that changes neither tenant nor expiry (a lease claim) writes
 *     nothing to `XeroConnection`;
 *   - a row the new release creates without its two ciphertext columns gets ''.
 */

const TOKEN_ROWS = (rows: string) => `
  INSERT INTO "XeroToken" (
    "id", "accessToken", "refreshToken", "expiresAt", "tenantId",
    "refreshInProgressUntil", "updatedAt"
  ) VALUES ${rows};
`;

const CONNECTION = `
  SELECT
    "id",
    "tenantId",
    to_char("expiresAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "expiresAt",
    to_char("refreshInProgressUntil", 'YYYY-MM-DD HH24:MI:SS.MS') AS "leaseUntil"
  FROM "XeroConnection"
  ORDER BY "id" COLLATE "C"
`;

/** A stamp the trigger could never write, so an unwanted write is visible. */
const SENTINEL = "2020-01-01 00:00:00.000";

const verification: DataMigrationVerification = {
  migration: "20261124010000_add_xero_connection",
  intent:
    "Create XeroConnection, backfill it from the most recently written XeroToken row (tenant and expiry only, never the lease), keep it following XeroToken through a statement trigger on every insert, update, delete and truncate, and give XeroToken's two ciphertext columns a '' default without rewriting any stored ciphertext.",
  executionMode: "isolated_database",
  idempotentReRun: false,
  cases: [
    {
      name: "an install that never connected Xero has no connection row",
      seed: "",
      expectations: [
        { claim: "no XeroToken row means no connection", sql: CONNECTION, rows: [] },
      ],
    },
    {
      name: "an install connected before the release stays connected, ciphertext untouched",
      seed: TOKEN_ROWS(`
        ('dmv-xc-token-a', 'iv:tag:access-cipher', 'iv:tag:refresh-cipher',
         TIMESTAMP '2026-10-01 00:30:00', 'tenant-a',
         TIMESTAMP '2026-10-01 00:02:00', TIMESTAMP '2026-10-01 00:00:00')
      `),
      expectations: [
        {
          claim:
            "the connection carries the row's tenant and expiry, and NOT the old release's lease",
          sql: CONNECTION,
          rows: [
            {
              id: "default",
              tenantId: "tenant-a",
              expiresAt: "2026-10-01 00:30:00.000",
              leaseUntil: null,
            },
          ],
        },
        {
          claim: "the stored ciphertext and the old lease are exactly as they were",
          sql: `
            SELECT "accessToken", "refreshToken",
              to_char("refreshInProgressUntil", 'YYYY-MM-DD HH24:MI:SS.MS') AS "leaseUntil"
            FROM "XeroToken"
          `,
          rows: [
            {
              accessToken: "iv:tag:access-cipher",
              refreshToken: "iv:tag:refresh-cipher",
              leaseUntil: "2026-10-01 00:02:00.000",
            },
          ],
        },
      ],
    },
    {
      name: "with two XeroToken rows the most recently written one is the connection",
      seed: TOKEN_ROWS(`
        ('dmv-xc-token-older', 'a', 'r', TIMESTAMP '2026-09-01 00:30:00', 'tenant-older',
         NULL, TIMESTAMP '2026-09-01 00:00:00'),
        ('dmv-xc-token-newer', 'a', 'r', TIMESTAMP '2026-10-01 00:30:00', 'tenant-newer',
         NULL, TIMESTAMP '2026-10-01 00:00:00')
      `),
      expectations: [
        {
          claim: "the newer row's tenant and expiry are copied",
          sql: CONNECTION,
          rows: [
            {
              id: "default",
              tenantId: "tenant-newer",
              expiresAt: "2026-10-01 00:30:00.000",
              leaseUntil: null,
            },
          ],
        },
      ],
    },
    {
      name: "the old release's first connect creates the connection",
      seed: "",
      afterMigration: TOKEN_ROWS(`
        ('dmv-xc-token-first', 'a', 'r', TIMESTAMP '2026-10-02 00:30:00', 'tenant-first',
         NULL, TIMESTAMP '2026-10-02 00:00:00')
      `),
      expectations: [
        {
          claim: "an insert into XeroToken alone produces the connection row",
          sql: CONNECTION,
          rows: [
            {
              id: "default",
              tenantId: "tenant-first",
              expiresAt: "2026-10-02 00:30:00.000",
              leaseUntil: null,
            },
          ],
        },
      ],
    },
    {
      name: "the old release's refresh and reconnect move the expiry and tenant but keep the new lease",
      seed: TOKEN_ROWS(`
        ('dmv-xc-token-a', 'a', 'r', TIMESTAMP '2026-10-01 00:30:00', 'tenant-a',
         NULL, TIMESTAMP '2026-10-01 00:00:00')
      `),
      afterMigration: `
        -- The new release holds its lease when the old one writes.
        UPDATE "XeroConnection"
        SET "refreshInProgressUntil" = TIMESTAMP '2026-10-01 00:05:00';

        UPDATE "XeroToken"
        SET "accessToken" = 'a2', "refreshToken" = 'r2',
            "expiresAt" = TIMESTAMP '2026-10-01 01:00:00',
            "tenantId" = 'tenant-b',
            "updatedAt" = TIMESTAMP '2026-10-01 00:31:00'
        WHERE "id" = 'dmv-xc-token-a';
      `,
      expectations: [
        {
          claim:
            "the tenant and expiry follow the old release's write; the new release's lease is untouched",
          sql: CONNECTION,
          rows: [
            {
              id: "default",
              tenantId: "tenant-b",
              expiresAt: "2026-10-01 01:00:00.000",
              leaseUntil: "2026-10-01 00:05:00.000",
            },
          ],
        },
      ],
    },
    {
      name: "a lease claim on XeroToken writes nothing to the connection",
      seed: TOKEN_ROWS(`
        ('dmv-xc-token-a', 'a', 'r', TIMESTAMP '2026-10-01 00:30:00', 'tenant-a',
         NULL, TIMESTAMP '2026-10-01 00:00:00')
      `),
      afterMigration: `
        UPDATE "XeroConnection" SET "updatedAt" = TIMESTAMP '${SENTINEL}';
        UPDATE "XeroToken"
        SET "refreshInProgressUntil" = TIMESTAMP '2026-10-01 00:02:00',
            "updatedAt" = TIMESTAMP '2026-10-01 00:00:30'
        WHERE "id" = 'dmv-xc-token-a';
      `,
      expectations: [
        {
          claim: "the connection row was not rewritten, and the old lease was not copied",
          sql: `
            SELECT
              to_char("updatedAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "updatedAt",
              ("refreshInProgressUntil" IS NULL) AS "leaseFree"
            FROM "XeroConnection"
          `,
          rows: [{ updatedAt: SENTINEL, leaseFree: true }],
        },
      ],
    },
    {
      name: "a change is stamped with the write's own UTC time",
      seed: TOKEN_ROWS(`
        ('dmv-xc-token-a', 'a', 'r', TIMESTAMP '2026-10-01 00:30:00', 'tenant-a',
         NULL, TIMESTAMP '2026-10-01 00:00:00')
      `),
      afterMigration: `
        SET TIME ZONE 'Pacific/Auckland';
        UPDATE "XeroToken"
        SET "expiresAt" = TIMESTAMP '2026-10-01 01:00:00'
        WHERE "id" = 'dmv-xc-token-a';
        RESET TIME ZONE;
      `,
      expectations: [
        {
          claim: "updatedAt falls in this or the previous UTC hour, not session-local time",
          sql: `
            SELECT COUNT(*)::integer AS "stampedNearNow"
            FROM "XeroConnection"
            WHERE to_char("updatedAt", 'YYYY-MM-DD HH24') IN (
              to_char(timezone('UTC', clock_timestamp()), 'YYYY-MM-DD HH24'),
              to_char(timezone('UTC', clock_timestamp()) - interval '1 hour', 'YYYY-MM-DD HH24')
            )
          `,
          rows: [{ stampedNearNow: 1 }],
        },
      ],
    },
    {
      name: "the old release's disconnect deletes the connection",
      seed: TOKEN_ROWS(`
        ('dmv-xc-token-a', 'a', 'r', TIMESTAMP '2026-10-01 00:30:00', 'tenant-a',
         NULL, TIMESTAMP '2026-10-01 00:00:00')
      `),
      afterMigration: `DELETE FROM "XeroToken";`,
      expectations: [
        { claim: "no XeroToken row is left, so no connection", sql: CONNECTION, rows: [] },
      ],
    },
    {
      name: "a TRUNCATE of XeroToken deletes the connection",
      seed: TOKEN_ROWS(`
        ('dmv-xc-token-a', 'a', 'r', TIMESTAMP '2026-10-01 00:30:00', 'tenant-a',
         NULL, TIMESTAMP '2026-10-01 00:00:00')
      `),
      afterMigration: `TRUNCATE "XeroToken";`,
      expectations: [
        { claim: "a truncate leaves no connection behind", sql: CONNECTION, rows: [] },
      ],
    },
    {
      name: "a row created without ciphertext gets '' in both columns",
      seed: "",
      afterMigration: `
        INSERT INTO "XeroToken" ("id", "expiresAt", "tenantId", "updatedAt")
        VALUES ('dmv-xc-token-new', TIMESTAMP '2026-10-03 00:30:00', 'tenant-new',
                TIMESTAMP '2026-10-03 00:00:00');
      `,
      expectations: [
        {
          claim: "the new release's create stores no ciphertext",
          sql: `SELECT "accessToken", "refreshToken" FROM "XeroToken"`,
          rows: [{ accessToken: "", refreshToken: "" }],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "take the OLDEST XeroToken row instead of the newest",
      harm:
        "With two rows the new release connects to a different tenant from the one the old release uses, so invoices and contacts go to the wrong organisation.",
      find: `ORDER BY "updatedAt" DESC, "id" DESC`,
      replace: `ORDER BY "updatedAt" ASC, "id" ASC`,
    },
    {
      name: "do not backfill",
      harm:
        "Every club connected before the release reads as not connected until an administrator reconnects, and every Xero sync stops.",
      find: `SELECT xero_connection_follow_token();`,
      replace: ``,
    },
    {
      name: "keep the connection when the last XeroToken row goes",
      harm:
        "After the old release disconnects, the new one still reports Xero connected over tokens that no longer exist.",
      find: `     WHERE NOT EXISTS (SELECT 1 FROM "XeroToken")`,
      replace: `     WHERE false`,
    },
    {
      name: "fire only on insert and update",
      harm:
        "The old release's disconnect leaves a phantom connection behind.",
      find: `AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "XeroToken"`,
      replace: `AFTER INSERT OR UPDATE ON "XeroToken"`,
    },
    {
      name: "do not fire on TRUNCATE",
      harm: "A truncate of the token table leaves a phantom connection behind.",
      find: `AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "XeroToken"`,
      replace: `AFTER INSERT OR UPDATE OR DELETE ON "XeroToken"`,
    },
    {
      name: "clear the new release's lease when the old release writes",
      harm:
        "A refresh the new release is part-way through loses its lease, so the old release can claim and spend the same rotating refresh token.",
      find: `           "updatedAt" = stamp
      FROM latest`,
      replace: `           "updatedAt" = stamp,
           "refreshInProgressUntil" = NULL
      FROM latest`,
    },
    {
      name: "rewrite the connection on every XeroToken write",
      harm:
        "Every lease claim on XeroToken also locks and rewrites the connection row, widening the lock footprint the refresh lease relies on staying small.",
      find: `
       AND (connection."tenantId" IS DISTINCT FROM latest."tenantId"
            OR connection."expiresAt" IS DISTINCT FROM latest."expiresAt")`,
      replace: ``,
    },
    {
      name: "stamp session-local time",
      harm:
        "On a database whose session zone is not UTC the connection's updatedAt lands hours away from every other timestamp the application writes.",
      find: `stamp TIMESTAMP(3) := timezone('UTC', statement_timestamp());`,
      replace: `stamp TIMESTAMP(3) := statement_timestamp();`,
    },
    {
      name: "no default for the access-token ciphertext",
      harm:
        "The new release, which cannot name the column, can no longer create the XeroToken row, so connecting Xero fails.",
      find: `ALTER TABLE "XeroToken" ALTER COLUMN "accessToken" SET DEFAULT '';`,
      replace: ``,
    },
    {
      name: "no default for the refresh-token ciphertext",
      harm:
        "The new release, which cannot name the column, can no longer create the XeroToken row, so connecting Xero fails.",
      find: `ALTER TABLE "XeroToken" ALTER COLUMN "refreshToken" SET DEFAULT '';`,
      replace: ``,
    },
  ],
};

export default verification;
