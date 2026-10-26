/**
 * THE PREVIOUS RELEASE'S XERO TOKEN STORE (#3454), as the statements it issues
 * against a real PostgreSQL — for `xero-token-credential-store.realdb.test.ts`,
 * which proves #3806 R2 against it.
 *
 * R2 runs beside the #3454 code during a blue-green deploy and is replaced by it
 * after a rollback. That code reads, refreshes, connects and disconnects only
 * through `XeroToken` and the credential-store row; it knows nothing of
 * `XeroConnection`. Its algorithm, restated here from the deployed
 * `src/lib/xero-token-store.ts` at #3454 (merge of PR #3805):
 *
 *   - ROW ORDER: `updatedAt` DESC only — #3454's `XERO_TOKEN_ROW_ORDER` had no
 *     `id` tie-break (R2's does), so this emulation has none either.
 *   - READ: the store row first, then the latest `XeroToken` row, or the row a
 *     won claim locked, BY ID. No row: not connected. The store copy is read
 *     when its `mirror` equals SHA-256(`${id}:${accessToken}:${refreshToken}`)
 *     of that row; otherwise the row's own ciphertext is decrypted.
 *   - CLAIM: in one transaction, find the latest row, `UPDATE ... SET lease
 *     WHERE id = <it> AND (lease IS NULL OR lease <= now)`, then read both
 *     copies by that id. The claim carries the row id and the store version.
 *   - REFRESH SAVE: one transaction: the CLAIMED row's ciphertext (a fresh IV
 *     each time), guarded on the lease, and the store copy with the matching
 *     `mirror`, compare-and-set on the claimed store version (`absent` when
 *     there was none).
 *   - CONNECT: one transaction: update the latest row in place (keeping its
 *     tenant when the grant names none) or create one; the store copy follows
 *     the row's tenant, with the matching `mirror`.
 *   - DISCONNECT: delete every `XeroToken` row and the store row; when only the
 *     row existed, one "pre-upgrade copy only" audit row.
 *   - `updatedAt` is the client's clock on every write, as Prisma's
 *     `@updatedAt` stamps it.
 *
 * WHERE IT DIFFERS from #3454, none of it on a path R2 is judged by:
 *
 *   - the row ciphertext is encrypted under a FIXED test key, where #3454
 *     resolved (and, when absent, generated and audited) the wrapped
 *     `xero` / `token_key`. R2 never reads it; a row R2 created holds '', which
 *     no key decrypts, so #3454 would read it as "reconnect required" — and
 *     never does, because R2's store copy always carries the matching `mirror`;
 *   - a row this emulation creates gets a random id, not Prisma's cuid;
 *   - its errors are plain `Error`s with "3454:" messages, not #3454's types.
 *
 * The R2 schema `@ignore`s the two ciphertext columns, so the generated client
 * cannot name them; that is why every statement here is raw SQL, the SQL the
 * #3454 client emitted. The store row goes through the real credential store,
 * which #3454 also used and R2 did not change; its writes run on the
 * application client, through `withCredentialTransaction`, as #3454's did.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import type { PrismaClient } from "@prisma/client";
import {
  CREDENTIAL_AUDIT_ACTIONS,
  recordCredentialMutation,
  type CredentialActor,
  type CredentialVersion,
} from "@/lib/integration-credential-actor";
import {
  deleteIntegrationCredentialInTransaction,
  deletedCredentialSummary,
  readIntegrationCredentialRow,
  setIntegrationCredentialInTransaction,
  withCredentialTransaction,
  type CredentialResolution,
} from "@/lib/integration-credentials";
import {
  XERO_OAUTH_TOKEN_KEY,
  XERO_OAUTH_TOKEN_PROVIDER,
  type TokenData,
} from "@/lib/xero-token-store";

const KEY = Buffer.from("7".repeat(64), "hex");

function encrypt(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted}`;
}

function decrypt(value: string): string {
  const [iv, tag, body] = value.split(":");
  if (!iv || !tag || body === undefined) throw new Error("3454: XeroTokenDecryptError");
  const decipher = createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "hex"), {
    authTagLength: 16,
  });
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return decipher.update(body, "hex", "utf8") + decipher.final("utf8");
}

/** #3454's `mirrorFingerprint`, byte for byte. */
export function fingerprint3454(row: {
  id: string;
  accessToken: string;
  refreshToken: string;
}): string {
  return createHash("sha256")
    .update(`${row.id}:${row.accessToken}:${row.refreshToken}`, "utf8")
    .digest("hex");
}

interface Row3454 {
  id: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string | null;
  refreshInProgressUntil: Date | null;
}

type Client = Pick<
  PrismaClient,
  "$queryRaw" | "$executeRaw" | "integrationCredential" | "auditLog"
>;

/** #3454's `findFirst({ orderBy: { updatedAt: "desc" } })`: no tie-break. */
async function latestRow(db: Client): Promise<Row3454 | null> {
  const rows = await db.$queryRaw<Row3454[]>`
    SELECT "id", "accessToken", "refreshToken", "expiresAt", "tenantId", "refreshInProgressUntil"
      FROM "XeroToken"
     ORDER BY "updatedAt" DESC
     LIMIT 1`;
  return rows[0] ?? null;
}

async function rowById(db: Client, id: string): Promise<Row3454 | null> {
  const rows = await db.$queryRaw<Row3454[]>`
    SELECT "id", "accessToken", "refreshToken", "expiresAt", "tenantId", "refreshInProgressUntil"
      FROM "XeroToken"
     WHERE "id" = ${id}`;
  return rows[0] ?? null;
}

export interface Read3454 {
  /** Which copy the #3454 code would hand its caller. */
  source: "store" | "row";
  rowId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  tenantId: string | null;
  refreshInProgressUntil: Date | null;
  /** The store version read beside it; `null` when there was no store row. */
  storeVersion: CredentialVersion | null;
}

function storeVersionOf(stored: CredentialResolution): CredentialVersion | null {
  return stored.status === "not_configured" ? null : stored.version;
}

/** #3454's `readCurrentTokens`: the latest row, or the locked one by id. */
async function readCurrent(db: Client, lockedRowId?: string): Promise<Read3454 | null> {
  const stored = await readIntegrationCredentialRow(
    db,
    XERO_OAUTH_TOKEN_PROVIDER,
    XERO_OAUTH_TOKEN_KEY,
  );
  const row = lockedRowId === undefined ? await latestRow(db) : await rowById(db, lockedRowId);
  if (!row) return null;
  const storeVersion = storeVersionOf(stored);
  if (stored.status === "configured") {
    const value = JSON.parse(stored.value) as {
      v: number;
      accessToken: string;
      refreshToken: string;
      expiresAt: string;
      tenantId: string | null;
      mirror?: unknown;
    };
    // #3454's parser required a string `mirror`; anything else is "not a set".
    if (value.v === 1 && typeof value.mirror === "string" && value.mirror === fingerprint3454(row)) {
      return {
        source: "store",
        rowId: row.id,
        accessToken: value.accessToken,
        refreshToken: value.refreshToken,
        expiresAt: new Date(value.expiresAt),
        tenantId: value.tenantId,
        refreshInProgressUntil: row.refreshInProgressUntil,
        storeVersion,
      };
    }
  }
  return {
    source: "row",
    rowId: row.id,
    accessToken: decrypt(row.accessToken),
    refreshToken: decrypt(row.refreshToken),
    expiresAt: row.expiresAt,
    tenantId: row.tenantId,
    refreshInProgressUntil: row.refreshInProgressUntil,
    storeVersion,
  };
}

/** #3454's unlocked read: what the previous release would use now. */
export async function read3454(db: Client): Promise<Read3454 | null> {
  return readCurrent(db);
}

/** A claim #3454 won: the tokens it read under the lease, and the lease. */
export interface Claim3454 {
  tokens: Read3454;
  leaseUntil: Date;
}

/**
 * #3454's `claimXeroTokenRefreshLease`: claim first, then read the locked row
 * by id. Returns the claim, or `null` when the lease was not taken.
 */
export async function claim3454(
  db: Pick<PrismaClient, "$transaction">,
  now: Date,
  leaseUntil: Date,
): Promise<Claim3454 | null> {
  return db.$transaction(async (tx) => {
    const row = await latestRow(tx);
    if (!row) return null;
    const count = await tx.$executeRaw`
      UPDATE "XeroToken"
         SET "refreshInProgressUntil" = ${leaseUntil}, "updatedAt" = ${new Date()}
       WHERE "id" = ${row.id}
         AND ("refreshInProgressUntil" IS NULL OR "refreshInProgressUntil" <= ${now})`;
    if (Number(count) !== 1) return null;
    const tokens = await readCurrent(tx, row.id);
    if (!tokens) throw new Error("3454: Xero token row changed under its own refresh lease");
    return { tokens: { ...tokens, refreshInProgressUntil: leaseUntil }, leaseUntil };
  });
}

/**
 * #3454's refresh save: the claimed row and the store copy under its lease,
 * the store write a compare-and-set on the version the claim read. Throws when
 * either fence no longer matches, as #3454 did.
 */
export async function save3454(
  tokens: TokenData,
  claim: Claim3454,
  actor: CredentialActor,
): Promise<void> {
  const access = encrypt(tokens.accessToken);
  const refresh = encrypt(tokens.refreshToken);
  const tenantId = tokens.tenantId ?? null;
  const storeVersion = claim.tokens.storeVersion;
  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
    const updated = await tx.$executeRaw`
      UPDATE "XeroToken"
         SET "accessToken" = ${access}, "refreshToken" = ${refresh},
             "expiresAt" = ${tokens.expiresAt}, "tenantId" = ${tenantId},
             "refreshInProgressUntil" = NULL, "updatedAt" = ${new Date()}
       WHERE "id" = ${claim.tokens.rowId} AND "refreshInProgressUntil" <= ${claim.leaseUntil}`;
    if (Number(updated) !== 1) {
      throw new Error("3454: Xero token refresh lease expired before refreshed tokens could be saved");
    }
    await setIntegrationCredentialInTransaction({
      tx,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      value: JSON.stringify({
        v: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt.toISOString(),
        tenantId,
        mirror: fingerprint3454({
          id: claim.tokens.rowId,
          accessToken: access,
          refreshToken: refresh,
        }),
      }),
      actor,
      expect:
        storeVersion === null
          ? { expect: "absent" }
          : { expect: "version", version: storeVersion },
      cause: { kind: "token-refresh" },
    });
  });
}

/** #3454's connect: update the latest row in place, or create one. */
export async function connect3454(
  tokens: TokenData,
  actor: CredentialActor,
): Promise<void> {
  const access = encrypt(tokens.accessToken);
  const refresh = encrypt(tokens.refreshToken);
  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
    const existing = await latestRow(tx);
    const id = existing?.id ?? `xt3454-${randomBytes(6).toString("hex")}`;
    // #3454 kept the row's tenant when the grant named none.
    const tenantId = tokens.tenantId ?? existing?.tenantId ?? null;
    const now = new Date();
    if (existing) {
      await tx.$executeRaw`
        UPDATE "XeroToken"
           SET "accessToken" = ${access}, "refreshToken" = ${refresh},
               "expiresAt" = ${tokens.expiresAt}, "tenantId" = ${tenantId},
               "refreshInProgressUntil" = NULL, "updatedAt" = ${now}
         WHERE "id" = ${id}`;
    } else {
      await tx.$executeRaw`
        INSERT INTO "XeroToken"
          ("id", "accessToken", "refreshToken", "expiresAt", "tenantId",
           "refreshInProgressUntil", "createdAt", "updatedAt")
        VALUES (${id}, ${access}, ${refresh}, ${tokens.expiresAt}, ${tenantId}, NULL, ${now}, ${now})`;
    }
    await setIntegrationCredentialInTransaction({
      tx,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      value: JSON.stringify({
        v: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt.toISOString(),
        tenantId,
        mirror: fingerprint3454({ id, accessToken: access, refreshToken: refresh }),
      }),
      actor,
      expect: { expect: "any" },
      cause: { kind: "oauth-connect" },
    });
  });
}

/** #3454's disconnect: every `XeroToken` row and the store row, one audit row. */
export async function disconnect3454(
  actor: CredentialActor,
): Promise<void> {
  await withCredentialTransaction([XERO_OAUTH_TOKEN_PROVIDER], async (tx) => {
    const rows = Number(await tx.$executeRaw`DELETE FROM "XeroToken"`);
    const storeRemoved = await deleteIntegrationCredentialInTransaction({
      tx,
      provider: XERO_OAUTH_TOKEN_PROVIDER,
      key: XERO_OAUTH_TOKEN_KEY,
      actor,
      expect: { expect: "any" },
      cause: { kind: "oauth-disconnect" },
    });
    if (!storeRemoved && rows > 0) {
      await recordCredentialMutation(tx, {
        action: CREDENTIAL_AUDIT_ACTIONS.deleted,
        summary: `${deletedCredentialSummary(XERO_OAUTH_TOKEN_PROVIDER, XERO_OAUTH_TOKEN_KEY)} (pre-upgrade copy only)`,
        actor,
        provider: XERO_OAUTH_TOKEN_PROVIDER,
        key: XERO_OAUTH_TOKEN_KEY,
        expectation: "any",
        cause: { kind: "oauth-disconnect" },
      });
    }
  });
}
