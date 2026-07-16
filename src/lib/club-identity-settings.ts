import "server-only";

/**
 * DB-first club identity (E3 #1929).
 *
 * The club name, short name, and hut-leader label are admin-editable and stored
 * in the ClubIdentitySettings singleton (id="default"). Every field is nullable
 * and resolves through a per-field fallback chain: DB row -> config/club.json
 * (via clubConfig) -> hard default. The lodge display name is NOT stored here —
 * it always resolves from the Lodge table (the club's default lodge), so lodge
 * identity has a single source of truth (mirrors email-message-settings.ts).
 *
 * Two accessors:
 *  - `getClubIdentity()` — async, awaits the DB. Wrap it in the tagged
 *    public-layout cache (getCachedClubIdentity in public-layout-config.ts) for
 *    layout/header/server consumption (#1884 pattern, 15s TTL, revalidateTag on
 *    the admin PUT AND config-transfer apply).
 *  - `getClubIdentitySync()` — a small self-warming, last-good process cache for
 *    the handful of GENUINELY synchronous call sites that cannot await (the TOTP
 *    issuer/label in two-factor.ts). Same shape as email-theme.ts's palette
 *    cache: returns the last-known value immediately, refreshes in the
 *    background when the TTL lapses, and is explicitly primed on the admin PUT
 *    and config-transfer apply so a rename reaches those sites promptly.
 */

import { clubConfig } from "@/config/club";
import { clubIdentity as configClubIdentity } from "@/config/club-identity";
import type { ClubIdentity } from "@/config/club-identity-types";
import { lodgeOrderBy } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

// The ClubIdentitySettings singleton row id. Its own constant (distinct from
// EmailMessageSetting's id, which happens to share the value "default").
export const CLUB_IDENTITY_SETTINGS_ID = "default";

export interface PersistedClubIdentity {
  name: string | null;
  shortName: string | null;
  hutLeaderLabel: string | null;
}

const HARD_DEFAULT_HUT_LEADER_LABEL = "Hut Leader";

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Pure per-field resolver (DB -> club.json -> hard default), extracted so the
 * fallback-order matrix can be unit-tested without a database. `persisted` is
 * the ClubIdentitySettings row (or null); `defaultLodgeName` is the club default
 * lodge's name (or null when no Lodge row resolves).
 */
export function resolveClubIdentity(
  persisted: PersistedClubIdentity | null,
  defaultLodgeName: string | null,
): ClubIdentity {
  const name = trimOptional(persisted?.name) ?? clubConfig.name;
  const shortName =
    trimOptional(persisted?.shortName) ?? clubConfig.shortName ?? name;
  const hutLeaderLabel =
    trimOptional(persisted?.hutLeaderLabel) ??
    clubConfig.hutLeaderLabel ??
    HARD_DEFAULT_HUT_LEADER_LABEL;
  // Lodge display name = the default lodge's name; only if no Lodge row resolves
  // do we fall back to the derived "<name> Lodge" shape (matches the email path).
  const lodgeName = trimOptional(defaultLodgeName) ?? `${name} Lodge`;

  return {
    // Non-identity fields (emails, URLs, social links, travel note, host,
    // capacity) are not admin-editable here and stay config-derived.
    ...configClubIdentity,
    name,
    shortName,
    hutLeaderLabel,
    lodgeName,
    bookingsName: `${name} - Bookings`,
  };
}

/**
 * Load the ClubIdentitySettings row defensively. Returns null when the row is
 * absent, the DB is unreachable (vitest runs with an unreachable DATABASE_URL),
 * or the delegate is missing — the caller then falls back to config defaults.
 */
export async function loadPersistedClubIdentity(): Promise<PersistedClubIdentity | null> {
  const delegate = (
    prisma as unknown as {
      clubIdentitySettings?: {
        findUnique: (args: unknown) => Promise<PersistedClubIdentity | null>;
      };
    }
  ).clubIdentitySettings;
  if (!delegate) return null;
  try {
    return await delegate.findUnique({
      where: { id: CLUB_IDENTITY_SETTINGS_ID },
      select: { name: true, shortName: true, hutLeaderLabel: true },
    });
  } catch {
    return null;
  }
}

/**
 * Resolve the club's default-lodge name (isDefault flag, else oldest active,
 * else oldest of any state — mirrors getDefaultLodgeId / default_lodge_id()).
 * Returns null when no Lodge row exists or the DB is unreachable.
 */
export async function loadDefaultLodgeName(): Promise<string | null> {
  const delegate = (
    prisma as unknown as {
      lodge?: {
        findFirst: (args: unknown) => Promise<{ name: string } | null>;
      };
    }
  ).lodge;
  if (!delegate) return null;
  const select = { name: true } as const;
  try {
    const lodge =
      (await delegate.findFirst({ where: { isDefault: true }, select })) ??
      (await delegate.findFirst({
        where: { active: true },
        orderBy: lodgeOrderBy(),
        select,
      })) ??
      (await delegate.findFirst({ orderBy: lodgeOrderBy(), select }));
    return lodge?.name ?? null;
  } catch {
    return null;
  }
}

/** Async DB-first club identity. Never throws — falls back to config defaults. */
export async function getClubIdentity(): Promise<ClubIdentity> {
  const [persisted, defaultLodgeName] = await Promise.all([
    loadPersistedClubIdentity(),
    loadDefaultLodgeName(),
  ]);
  return resolveClubIdentity(persisted, defaultLodgeName);
}

// ---------------------------------------------------------------------------
// Synchronous accessor (self-warming process cache) — email-theme.ts pattern.
// ONLY for genuinely-sync call sites that cannot await (the TOTP issuer/label).
// Public surfaces use the tagged async cache instead; a ≤ TTL lag here is
// acceptable because the TOTP issuer label only affects NEW enrolments.
// ---------------------------------------------------------------------------

const SYNC_TTL_MS = 5 * 60 * 1000;
const DEFAULT_IDENTITY: ClubIdentity = resolveClubIdentity(null, null);

let cached: ClubIdentity = DEFAULT_IDENTITY;
let cachedAt = 0;
let refreshing = false;
// Monotonic token orders concurrent reads so the last-STARTED read wins and a
// slow background refresh cannot clobber a fresher prime (see email-theme.ts).
let latestWriteToken = 0;

async function refreshClubIdentitySync(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  cachedAt = Date.now();
  const token = ++latestWriteToken;
  try {
    const identity = await getClubIdentity();
    if (token === latestWriteToken) {
      cached = identity;
    }
  } catch {
    // Keep the last-good/default identity; never throw from a background refresh.
  } finally {
    refreshing = false;
  }
}

/**
 * Synchronous club-identity accessor. Returns the cached identity immediately
 * and self-warms in the background when the TTL lapses. The first read after a
 * cold start returns config defaults until the cache warms.
 */
export function getClubIdentitySync(): ClubIdentity {
  if (Date.now() - cachedAt > SYNC_TTL_MS) {
    void refreshClubIdentitySync();
  }
  return cached;
}

/**
 * Await an unconditional refresh of the sync identity cache. Called from the
 * admin PUT and config-transfer apply so a rename reaches the sync call sites
 * promptly rather than only after the TTL lapses. Never throws.
 */
export async function primeClubIdentitySync(): Promise<void> {
  const token = ++latestWriteToken;
  try {
    const identity = await getClubIdentity();
    if (token === latestWriteToken) {
      cached = identity;
      cachedAt = Date.now();
    }
  } catch {
    // Keep the last-good/default identity; never throw from priming.
  }
}

/** Test hook: reset the sync cache to its initial cold state. */
export function __resetClubIdentitySyncCacheForTests(): void {
  cached = DEFAULT_IDENTITY;
  cachedAt = 0;
  refreshing = false;
  latestWriteToken = 0;
}
