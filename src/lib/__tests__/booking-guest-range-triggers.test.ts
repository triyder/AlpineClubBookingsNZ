import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

import { FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL } from "@/lib/booking-envelope-invariants";

const databaseUrl = process.env.BOOKING_GUEST_RANGE_TRIGGER_TEST_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const TRIGGER_MIGRATIONS = [
  "prisma/migrations/20260525030000_enforce_booking_guest_stay_range_envelope/migration.sql",
  "prisma/migrations/20260704100000_defer_booking_guest_stay_range_triggers/migration.sql",
];

async function withTriggerSchema(
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const schemaName = `booking_guest_range_${randomUUID().replaceAll("-", "")}`;
  const schema = quoteIdentifier(schemaName);
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE "Booking" (
        "id" TEXT PRIMARY KEY,
        "checkIn" DATE NOT NULL,
        "checkOut" DATE NOT NULL
      );

      CREATE TABLE "BookingGuest" (
        "id" TEXT PRIMARY KEY,
        "bookingId" TEXT NOT NULL REFERENCES "Booking"("id") ON DELETE CASCADE,
        "stayStart" DATE NOT NULL,
        "stayEnd" DATE NOT NULL
      );
    `);
    for (const migrationPath of TRIGGER_MIGRATIONS) {
      const migration = await readFile(
        path.join(process.cwd(), migrationPath),
        "utf8",
      );
      await client.query(migration);
    }

    await client.query(`
      INSERT INTO "Booking" ("id", "checkIn", "checkOut")
      VALUES ('booking-1', DATE '2026-06-10', DATE '2026-06-15')
    `);
    await client.query(`
      INSERT INTO "BookingGuest" ("id", "bookingId", "stayStart", "stayEnd")
      VALUES ('guest-valid', 'booking-1', DATE '2026-06-10', DATE '2026-06-12')
    `);

    await run(client);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

describeWithDatabase("BookingGuest stay range database triggers", () => {
  it("rejects guest rows and booking date updates outside the booking envelope", async () => {
    await withTriggerSchema(async (client) => {
      await expect(
        client.query(`
          INSERT INTO "BookingGuest" ("id", "bookingId", "stayStart", "stayEnd")
          VALUES ('guest-outside', 'booking-1', DATE '2026-06-09', DATE '2026-06-12')
        `),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "BookingGuest_stay_range_within_booking",
      });

      await expect(
        client.query(`
          UPDATE "Booking"
          SET "checkIn" = DATE '2026-06-11'
          WHERE "id" = 'booking-1'
        `),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "Booking_dates_consistent_with_guests",
      });
    });
  });

  it("allows a transaction that widens guest ranges before the parent booking", async () => {
    // Regression: issue #713 auto-expands the booking envelope from guest
    // stay ranges, and the modify flows write the widened guest rows before
    // the parent Booking row. The deferred constraint triggers must validate
    // the envelope at COMMIT, not per statement.
    await withTriggerSchema(async (client) => {
      await client.query("BEGIN");
      await client.query(`
        UPDATE "BookingGuest"
        SET "stayEnd" = DATE '2026-06-17'
        WHERE "id" = 'guest-valid'
      `);
      await client.query(`
        UPDATE "Booking"
        SET "checkOut" = DATE '2026-06-17'
        WHERE "id" = 'booking-1'
      `);
      await expect(client.query("COMMIT")).resolves.toBeDefined();

      const { rows } = await client.query(`
        SELECT "stayEnd"::text AS "stayEnd" FROM "BookingGuest" WHERE "id" = 'guest-valid'
      `);
      expect(rows[0].stayEnd).toBe("2026-06-17");
    });
  });

  it("still rejects at commit when the transaction leaves a guest outside the envelope", async () => {
    await withTriggerSchema(async (client) => {
      await client.query("BEGIN");
      await client.query(`
        UPDATE "BookingGuest"
        SET "stayEnd" = DATE '2026-06-17'
        WHERE "id" = 'guest-valid'
      `);
      await expect(client.query("COMMIT")).rejects.toMatchObject({
        code: "23514",
        constraint: "BookingGuest_stay_range_within_booking",
      });
    });
  });

  it("surfaces a violation at the SET CONSTRAINTS flush instead of COMMIT", async () => {
    // assertBookingEnvelopeInvariants runs this statement at the end of the
    // modification transactions so a write-path bug is attributed to the
    // service, not to prisma.$transaction's COMMIT.
    await withTriggerSchema(async (client) => {
      await client.query("BEGIN");
      await client.query(`
        UPDATE "BookingGuest"
        SET "stayEnd" = DATE '2026-06-17'
        WHERE "id" = 'guest-valid'
      `);
      await expect(
        client.query(FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL),
      ).rejects.toMatchObject({
        code: "23514",
        constraint: "BookingGuest_stay_range_within_booking",
      });
      await client.query("ROLLBACK");
    });
  });

  it("passes the SET CONSTRAINTS flush and commits when the envelope is consistent", async () => {
    await withTriggerSchema(async (client) => {
      await client.query("BEGIN");
      await client.query(`
        UPDATE "BookingGuest"
        SET "stayEnd" = DATE '2026-06-17'
        WHERE "id" = 'guest-valid'
      `);
      await client.query(`
        UPDATE "Booking"
        SET "checkOut" = DATE '2026-06-17'
        WHERE "id" = 'booking-1'
      `);
      await expect(
        client.query(FLUSH_BOOKING_ENVELOPE_CONSTRAINTS_SQL),
      ).resolves.toBeDefined();
      await expect(client.query("COMMIT")).resolves.toBeDefined();
    });
  });
});
