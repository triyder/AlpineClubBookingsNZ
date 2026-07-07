import type { Lodge, Prisma, PrismaClient } from "@prisma/client";

// Callers pass their own Prisma client/transaction so this module stays free
// of the app prisma singleton and safe to import from prisma/seed.ts.
type LodgeDb = Pick<PrismaClient, "lodge">;

// Lodge management helpers for the multiLodge Admin Module (phase 1 of
// docs/multi-lodge/implementation-plan.md). The Lodge table is core and every
// deployment has at least one row; these helpers manage lodge identity only.
// Capacity, pricing, and booking scoping arrive in later phases.

export const lodgeSelect = {
  id: true,
  name: true,
  slug: true,
  active: true,
  doorCode: true,
  travelNote: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.LodgeSelect;

export type LodgeRecord = Pick<Lodge, keyof typeof lodgeSelect>;

export interface SerializedLodge {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  doorCode: string | null;
  travelNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export function serializeLodge(lodge: LodgeRecord): SerializedLodge {
  return {
    id: lodge.id,
    name: lodge.name,
    slug: lodge.slug,
    active: lodge.active,
    doorCode: lodge.doorCode,
    travelNote: lodge.travelNote,
    createdAt: lodge.createdAt.toISOString(),
    updatedAt: lodge.updatedAt.toISOString(),
  };
}

export function lodgeOrderBy() {
  return [{ createdAt: "asc" }, { id: "asc" }] satisfies
    Prisma.LodgeOrderByWithRelationInput[];
}

export function normalizeLodgeText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function slugifyLodgeName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "lodge";
}

export async function buildUniqueLodgeSlug(
  db: LodgeDb,
  name: string,
  excludeLodgeId?: string,
): Promise<string> {
  const base = slugifyLodgeName(name);
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    const clash = await db.lodge.findFirst({
      where: {
        slug: candidate,
        ...(excludeLodgeId ? { id: { not: excludeLodgeId } } : {}),
      },
      select: { id: true },
    });
    if (!clash) return candidate;
  }
  throw new Error(`Could not derive a unique lodge slug from "${name}"`);
}

export async function countActiveLodges(db: LodgeDb): Promise<number> {
  return db.lodge.count({ where: { active: true } });
}

// Prisma where-fragment scoping a query to exactly one lodge. Named for the
// historical expand-release null tolerance; the entity tables it is used on now
// have a NOT NULL lodgeId, so it is a strict match (see below).
export function lodgeNullTolerantScope(lodgeId: string) {
  // The entity tables this scopes (Booking, Season, LodgeRoom, Locker,
  // ChoreTemplate, HutLeaderAssignment) are NOT NULL on lodgeId, so a strict
  // per-lodge match is exact — there are no null-lodge rows to tolerate. (Policy
  // tables keep nullable lodgeId and scope via resolvePolicyRowsForLodge, not
  // this helper.)
  return { lodgeId };
}

// Resolve the club-wide-with-override policy pattern (ADR-001 resolved
// question 3) for one lodge: rows with a matching lodgeId are that lodge's
// override set and REPLACE the club-wide (null lodgeId) rows entirely — never
// merged. Rows belonging to other lodges are always excluded. All three
// policy types (CancellationPolicy, MinimumStayPolicy, BookingPeriod) must
// resolve through this helper so the replace-not-merge rule cannot drift
// (docs/multi-lodge/lodge-scoping-contract.md).
export function resolvePolicyRowsForLodge<
  T extends { lodgeId?: string | null },
>(rows: readonly T[], lodgeId: string): T[] {
  const lodgeRows = rows.filter((row) => row.lodgeId === lodgeId);
  if (lodgeRows.length > 0) return lodgeRows;
  // Loose null check: rows from narrow selects (or fixtures) may omit the
  // column entirely; a missing lodgeId means club-wide, same as null.
  return rows.filter((row) => row.lodgeId == null);
}

// Phase-2 bridging resolver: writers that do not yet receive an explicit
// lodge from their caller stamp new rows with the club's default lodge (the
// oldest active one — the phase-1 seeded lodge in every current deployment).
// Phases 3+ replace call sites with real lodge context threaded from the
// request; do not add new callers once a surface carries its own lodgeId.
//
// MIRROR CONTRACT: this resolution (oldest active lodge, else oldest lodge of
// any state) must stay byte-identical to the default_lodge_id() SQL function
// created in migration 20260708001100 — that function backs the column DEFAULT
// that keeps the lodgeId NOT NULLs old-code-compatible. The fallback to an
// inactive lodge is deliberate so both sides always resolve the same row. Any
// change to the ordering/fallback here must be mirrored by a new migration that
// replaces the SQL function (and vice versa), or a blue/green cutover could
// stamp different lodges from the two code paths.
export async function getDefaultLodgeId(db: LodgeDb): Promise<string> {
  const lodge =
    (await db.lodge.findFirst({
      where: { active: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    })) ??
    (await db.lodge.findFirst({
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    }));

  if (!lodge) {
    throw new Error(
      "No Lodge row exists; run migrations/seed before creating lodge-scoped records",
    );
  }
  return lodge.id;
}

// Resolve an admin-supplied optional lodgeId: a provided id must name an
// active lodge (returns null when it does not, so callers can 400), and an
// omitted id falls back to the club's default lodge. One helper so the
// admin create/update routes cannot drift on how they validate lodge input.
export async function resolveOptionalActiveLodgeId(
  db: LodgeDb,
  requestedLodgeId: string | null | undefined,
): Promise<string | null> {
  if (requestedLodgeId) {
    const lodge = await db.lodge.findUnique({
      where: { id: requestedLodgeId },
      select: { id: true, active: true },
    });
    return lodge?.active ? lodge.id : null;
  }
  return getDefaultLodgeId(db);
}

// Compatibility path (implementation-plan.md phase 1): email rendering still
// reads lodge identity from the EmailMessageSetting singleton until phase 8
// switches templates to per-booking lodge context. While the club has exactly
// one active lodge, keep that singleton in sync so lodge edits show up in
// emails immediately. With more than one active lodge the singleton is
// ambiguous by design and is left untouched.
export async function syncSoleActiveLodgeIdentity(
  tx: Prisma.TransactionClient,
): Promise<void> {
  const activeLodges = await tx.lodge.findMany({
    where: { active: true },
    select: { name: true, doorCode: true, travelNote: true },
    take: 2,
  });
  if (activeLodges.length !== 1) return;

  const [lodge] = activeLodges;
  const identity = {
    lodgeName: lodge.name,
    doorCode: lodge.doorCode,
    lodgeTravelNote: lodge.travelNote,
  };

  await tx.emailMessageSetting.upsert({
    where: { id: "default" },
    create: { id: "default", ...identity },
    update: identity,
  });
}
