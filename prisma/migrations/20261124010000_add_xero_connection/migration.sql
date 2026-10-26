BEGIN;

-- #3806 release R2 (owner decisions D1 and D2, 6 Oct 2026): the Xero refresh
-- lease and the "is Xero connected" truth move to a new, dedicated table that
-- holds no secret. `XeroToken` is dropped in a later release; until then the
-- previous release (#3454) may still run beside this one, during the deploy
-- window and after any rollback, and it reads, refreshes, connects and
-- disconnects through `XeroToken` alone.
--
-- FIVE STATEMENTS, one transaction.
--
-- 1. `XeroToken."accessToken"` and `"refreshToken"` get a DEFAULT of ''. This
--    release's Prisma schema marks both columns `@ignore`, so its client can no
--    longer name them anywhere: not in a SELECT, an INSERT column list or a
--    RETURNING (INV-OPS-005). When it creates the row the #3454 code reads as
--    "connected", the database fills them with '' instead. The #3454 code always
--    supplies both, so the default changes nothing for it.
--
-- 2. `XeroConnection`, a one-row table: the connected tenant, the access
--    token's expiry and the refresh lease. No token, ciphertext or key.
--
-- 3 and 4. A function and a statement trigger that keep `XeroConnection` in
--    step with `XeroToken` whoever writes it. The #3454 code writes only
--    `XeroToken`, so without this its connect, refresh and disconnect would
--    leave this table saying something else: a phantom connection after it
--    disconnects, the old tenant after it reconnects to another organisation,
--    or no connection at all after a first connect. The trigger makes the new
--    table follow the most recently written `XeroToken` row (`updatedAt`,
--    then `id`, descending: this release's `XERO_TOKEN_ROW_ORDER`): no row
--    deletes the connection; otherwise it copies `tenantId` and `expiresAt`.
--    It never touches the lease column, which only this release's code writes.
--    The function is ONE statement, so it reads one snapshot, taken once its
--    lock on `XeroConnection` is granted: a refresh or connect committing
--    while it runs is either wholly seen or wholly unseen, never half. It
--    writes only a row whose value differs, so a lease claim on `XeroToken`,
--    which changes neither value, writes nothing here and waits on no
--    `XeroConnection` writer. It takes the table's ROW EXCLUSIVE lock, which
--    conflicts only with DDL and explicit table locks; it waits for another
--    transaction only to change a row that transaction is writing, or to
--    insert the row another transaction is inserting at the same moment.
--
-- 5. The backfill: one call of the same function, so the row this migration
--    writes and the row every later write produces come from one definition.
--
-- LOCK ORDER: every writer that touches both tables touches `XeroToken` first,
-- because the trigger runs at the end of each `XeroToken` statement. This
-- release's code keeps that order (CONCURRENCY_AND_LOCKING.md, the Xero token
-- refresh lease).
--
-- The trigger is retired with `XeroToken` (the R3 checklist on #3806): the
-- release that stops writing `XeroToken` drops the trigger and the function
-- first, and the table goes after it.
--
-- LOCK IMPACT: ALTER COLUMN ... SET DEFAULT is catalog-only and takes ACCESS
-- EXCLUSIVE on "XeroToken"; CREATE TRIGGER takes SHARE ROW EXCLUSIVE on it.
-- The table holds one row (rarely two), and the backfill reads it once, so the
-- locks are held for milliseconds until this transaction commits.

ALTER TABLE "XeroToken" ALTER COLUMN "accessToken" SET DEFAULT '';
ALTER TABLE "XeroToken" ALTER COLUMN "refreshToken" SET DEFAULT '';

CREATE TABLE "XeroConnection" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "tenantId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshInProgressUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XeroConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "XeroConnection_singleton" CHECK ("id" = 'default')
);

CREATE FUNCTION xero_connection_follow_token()
RETURNS void
LANGUAGE plpgsql
AS $xero_connection_follow_token$
DECLARE
  stamp TIMESTAMP(3) := timezone('UTC', statement_timestamp());
BEGIN
  -- ONE statement, so every part of it reads one snapshot, taken after its lock
  -- on "XeroConnection" is granted. Separate statements would each read their
  -- own, and a write committing between them would be overwritten by the
  -- earlier read: a stale tenant or expiry, or a just-made connection deleted.
  WITH latest AS (
    SELECT "tenantId", "expiresAt"
      FROM "XeroToken"
     ORDER BY "updatedAt" DESC, "id" DESC
     LIMIT 1
  ),
  disconnected AS (
    DELETE FROM "XeroConnection"
     WHERE NOT EXISTS (SELECT 1 FROM "XeroToken")
  ),
  followed AS (
    UPDATE "XeroConnection" AS connection
       SET "tenantId" = latest."tenantId",
           "expiresAt" = latest."expiresAt",
           "updatedAt" = stamp
      FROM latest
     WHERE connection."id" = 'default'
       AND (connection."tenantId" IS DISTINCT FROM latest."tenantId"
            OR connection."expiresAt" IS DISTINCT FROM latest."expiresAt")
  )
  INSERT INTO "XeroConnection" ("id", "tenantId", "expiresAt", "createdAt", "updatedAt")
  SELECT 'default', latest."tenantId", latest."expiresAt", stamp, stamp
    FROM latest
   WHERE NOT EXISTS (SELECT 1 FROM "XeroConnection")
  ON CONFLICT ("id") DO NOTHING;
END
$xero_connection_follow_token$;

CREATE FUNCTION xero_connection_follow_token_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $xero_connection_follow_token_trigger$
BEGIN
  PERFORM xero_connection_follow_token();
  RETURN NULL;
END
$xero_connection_follow_token_trigger$;

CREATE TRIGGER "XeroToken_xero_connection_follow"
AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "XeroToken"
FOR EACH STATEMENT
EXECUTE FUNCTION xero_connection_follow_token_trigger();

SELECT xero_connection_follow_token();

COMMIT;
