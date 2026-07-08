import { strToU8, strFromU8 } from "fflate";

import type { BundleEntry } from "../bundle";
import { serialiseCsv, parseCsv } from "../csv";
import { registerEntity } from "../registry";
import type { CategoryExporter, ExportContext } from "../export-types";
import {
  hashRow,
  type ApplyContext,
  type CategoryApplyResult,
  type CategoryImporter,
  type CategoryPlanResult,
  type PlanContext,
  type PlanItem,
} from "../import-types";

// lodge-config category (part 1): lodges + their rooms + beds + seasons + rates
// — the structural "multi-lodge" core. Each lodge is a self-contained folder,
//   lodge-config/lodges/<slug>/
//     lodge.json          { slug, name, active, travelNote, doorCode? }
//     rooms.csv           name, sortOrder, active, notes
//     beds.csv            roomName, name, sortOrder, active
//     seasons.csv         name, type, startDate, endDate, active
//     season-rates.csv    seasonName, ageTier, isMember, pricePerNightCents
// so the lodge a row belongs to is implied by the folder (not a CSV column),
// making a whole lodge easy to add/curate/spot as a unit. The authoritative
// slug is lodge.json's `slug` — the folder name is just a container.
//
// Per-lodge capacity/settings stay out of scope (their id="default"-vs-lodgeId
// storage duality makes cross-instance round-tripping unsafe; set them on the
// lodge page). See ADR-001/002.

/** Every per-lodge folder lives under this prefix. */
export const LODGES_PREFIX = "lodge-config/lodges/";

const LODGE_JSON = "lodge.json";
const ROOMS_CSV = "rooms.csv";
const BEDS_CSV = "beds.csv";
const SEASONS_CSV = "seasons.csv";
const RATES_CSV = "season-rates.csv";

const LODGE_FIELDS = ["slug", "name", "active", "travelNote", "doorCode"] as const;
const ROOM_FIELDS = ["name", "sortOrder", "active", "notes"] as const;
const BED_FIELDS = ["roomName", "name", "sortOrder", "active"] as const;
const SEASON_FIELDS = ["name", "type", "startDate", "endDate", "active"] as const;
const RATE_FIELDS = ["seasonName", "ageTier", "isMember", "pricePerNightCents"] as const;

/** Folder-name segment for a lodge slug (slugs are url-safe; guard anyway). */
function folderSegment(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** The seven possible file paths inside one lodge folder segment. */
export function lodgeFolderFiles(segment: string) {
  const base = `${LODGES_PREFIX}${segment}`;
  return {
    lodge: `${base}/${LODGE_JSON}`,
    rooms: `${base}/${ROOMS_CSV}`,
    beds: `${base}/${BEDS_CSV}`,
    seasons: `${base}/${SEASONS_CSV}`,
    rates: `${base}/${RATES_CSV}`,
    instructions: `${base}/instructions.csv`,
    choreTemplates: `${base}/chore-templates.csv`,
  };
}

/** Folder segments present in the bundle, sorted for deterministic apply order. */
export function lodgeFolderSegments(files: Map<string, Uint8Array>): string[] {
  const set = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(LODGES_PREFIX)) continue;
    const seg = path.slice(LODGES_PREFIX.length).split("/")[0];
    if (seg) set.add(seg);
  }
  return [...set].sort();
}

/** The authoritative lodge slug for a folder segment, from its lodge.json. */
export function folderLodgeSlug(
  files: Map<string, Uint8Array>,
  segment: string,
): string | null {
  const descriptor = readLodgeJson(files, lodgeFolderFiles(segment).lodge);
  const slug = asStr(descriptor?.slug);
  return slug || null;
}

/** date-only (@db.Date) helpers: serialise as YYYY-MM-DD, parse to UTC midnight. */
function toDateStr(value: Date | null | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : "";
}
function fromDateStr(value: unknown): Date {
  return new Date(`${asStr(value).trim()}T00:00:00.000Z`);
}

registerEntity({
  entity: "lodge",
  category: "lodge-config",
  tier: "key-strong",
  format: "json",
  file: `${LODGES_PREFIX}<slug>/${LODGE_JSON}`,
  naturalKey: ["slug"],
  singleton: false,
  fields: [...LODGE_FIELDS],
  optInFields: ["doorCode"],
});
registerEntity({
  entity: "lodge-room",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${ROOMS_CSV}`,
  naturalKey: ["name"],
  singleton: false,
  fields: [...ROOM_FIELDS],
});
registerEntity({
  entity: "lodge-bed",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${BEDS_CSV}`,
  naturalKey: ["roomName", "name"],
  singleton: false,
  fields: [...BED_FIELDS],
});
registerEntity({
  entity: "season",
  category: "lodge-config",
  tier: "key-weak",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${SEASONS_CSV}`,
  naturalKey: ["name"],
  singleton: false,
  fields: [...SEASON_FIELDS],
});
registerEntity({
  entity: "season-rate",
  category: "lodge-config",
  tier: "key-strong",
  format: "csv",
  file: `${LODGES_PREFIX}<slug>/${RATES_CSV}`,
  naturalKey: ["seasonName", "ageTier", "isMember"],
  singleton: false,
  fields: [...RATE_FIELDS],
});

function asStr(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
function asNullableStr(value: unknown): string | null {
  const s = asStr(value);
  return s === "" ? null : s;
}
function coerceInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(asStr(value).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}
function coerceBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return asStr(value).trim().toLowerCase() === "true";
}
function readCsv(files: Map<string, Uint8Array>, path: string) {
  const bytes = files.get(path);
  return bytes ? parseCsv(strFromU8(bytes)).rows : [];
}
/** Read a lodge.json descriptor as a loose record (tolerant for hand-editing). */
function readLodgeJson(
  files: Map<string, Uint8Array>,
  path: string,
): Record<string, unknown> | null {
  const bytes = files.get(path);
  if (!bytes) return null;
  try {
    const value = JSON.parse(strFromU8(bytes));
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---- Export ----------------------------------------------------------------

export const lodgeConfigExporter: CategoryExporter = {
  category: "lodge-config",
  descriptors: [],
  async export(ctx: ExportContext): Promise<BundleEntry[]> {
    const lodges = await ctx.db.lodge.findMany({
      orderBy: { slug: "asc" },
      select: { slug: true, name: true, active: true, travelNote: true, doorCode: true },
    });
    const rooms = await ctx.db.lodgeRoom.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, sortOrder: true, active: true, notes: true, lodge: { select: { slug: true } } },
    });
    const beds = await ctx.db.lodgeBed.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { name: true, sortOrder: true, active: true, room: { select: { name: true, lodge: { select: { slug: true } } } } },
    });
    const seasons = await ctx.db.season.findMany({
      orderBy: [{ startDate: "asc" }, { name: "asc" }],
      select: { name: true, type: true, startDate: true, endDate: true, active: true, lodge: { select: { slug: true } } },
    });
    const rates = await ctx.db.seasonRate.findMany({
      orderBy: [{ ageTier: "asc" }, { isMember: "asc" }],
      select: { ageTier: true, isMember: true, pricePerNightCents: true, season: { select: { name: true, lodge: { select: { slug: true } } } } },
    });

    // Group the collections by lodge slug.
    const bySlug = <T>() => new Map<string, T[]>();
    const roomsBy = bySlug<Record<string, unknown>>();
    const bedsBy = bySlug<Record<string, unknown>>();
    const seasonsBy = bySlug<Record<string, unknown>>();
    const ratesBy = bySlug<Record<string, unknown>>();
    const push = <T>(map: Map<string, T[]>, slug: string, row: T) => {
      const list = map.get(slug) ?? [];
      list.push(row);
      map.set(slug, list);
    };
    for (const r of rooms) push(roomsBy, r.lodge.slug, { name: r.name, sortOrder: r.sortOrder, active: r.active, notes: r.notes });
    for (const b of beds) push(bedsBy, b.room.lodge.slug, { roomName: b.room.name, name: b.name, sortOrder: b.sortOrder, active: b.active });
    for (const s of seasons) push(seasonsBy, s.lodge.slug, { name: s.name, type: s.type, startDate: toDateStr(s.startDate), endDate: toDateStr(s.endDate), active: s.active });
    for (const r of rates) push(ratesBy, r.season.lodge.slug, { seasonName: r.season.name, ageTier: r.ageTier, isMember: r.isMember, pricePerNightCents: r.pricePerNightCents });

    const entries: BundleEntry[] = [];
    for (const lodge of lodges) {
      const paths = lodgeFolderFiles(folderSegment(lodge.slug));
      const descriptor: Record<string, unknown> = {
        slug: lodge.slug,
        name: lodge.name,
        active: lodge.active,
        travelNote: lodge.travelNote,
      };
      if (ctx.includeDoorCodes) descriptor.doorCode = lodge.doorCode;
      entries.push({
        path: paths.lodge,
        category: "lodge-config",
        rowCount: null,
        bytes: strToU8(JSON.stringify(descriptor, null, 2)),
      });

      // Always emit the full per-lodge skeleton (header-only when empty) so a
      // lodge folder captures the entire lodge config and the format is
      // self-documenting for hand-authoring from scratch.
      const emit = (path: string, fields: readonly string[], rows: Record<string, unknown>[]) => {
        entries.push({ path, category: "lodge-config", rowCount: rows.length, bytes: strToU8(serialiseCsv([...fields], rows)) });
      };
      emit(paths.rooms, ROOM_FIELDS, roomsBy.get(lodge.slug) ?? []);
      emit(paths.beds, BED_FIELDS, bedsBy.get(lodge.slug) ?? []);
      emit(paths.seasons, SEASON_FIELDS, seasonsBy.get(lodge.slug) ?? []);
      emit(paths.rates, RATE_FIELDS, ratesBy.get(lodge.slug) ?? []);
    }
    return entries;
  },
};

// ---- Plan ------------------------------------------------------------------

async function planLodgeConfig(ctx: PlanContext): Promise<CategoryPlanResult> {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  const fingerprintParts: string[] = [];

  for (const segment of lodgeFolderSegments(ctx.files)) {
    const paths = lodgeFolderFiles(segment);
    const descriptor = readLodgeJson(ctx.files, paths.lodge);
    if (!descriptor || !asStr(descriptor.slug)) {
      warnings.push(`Lodge folder "${segment}" has no readable lodge.json; its rooms/beds will be skipped.`);
      continue;
    }
    const slug = asStr(descriptor.slug);

    // Lodge.
    const currentLodge = await ctx.db.lodge.findUnique({
      where: { slug },
      select: { slug: true, name: true, active: true, travelNote: true, doorCode: true },
    });
    fingerprintParts.push(`lodge:${slug}:${currentLodge ? hashRow([...LODGE_FIELDS], currentLodge) : "absent"}`);
    items.push({ entity: "lodge", key: slug, action: currentLodge ? "update" : "create" });

    const lodgeId = currentLodge ? (await ctx.db.lodge.findUnique({ where: { slug }, select: { id: true } }))?.id ?? null : null;

    // Rooms.
    for (const raw of readCsv(ctx.files, paths.rooms)) {
      const key = `${slug}/${raw.name}`;
      const current = lodgeId
        ? await ctx.db.lodgeRoom.findUnique({ where: { lodgeId_name: { lodgeId, name: raw.name ?? "" } }, select: { name: true, sortOrder: true, active: true, notes: true } })
        : null;
      fingerprintParts.push(`lodge-room:${key}:${current ? hashRow(["name", "sortOrder", "active", "notes"], current) : "absent"}`);
      items.push({ entity: "lodge-room", key, action: current ? "update" : "create" });
    }

    // Beds.
    for (const raw of readCsv(ctx.files, paths.beds)) {
      const key = `${slug}/${raw.roomName}/${raw.name}`;
      const room = lodgeId
        ? await ctx.db.lodgeRoom.findUnique({ where: { lodgeId_name: { lodgeId, name: raw.roomName ?? "" } }, select: { id: true } })
        : null;
      const current = room
        ? await ctx.db.lodgeBed.findUnique({ where: { roomId_name: { roomId: room.id, name: raw.name ?? "" } }, select: { name: true, sortOrder: true, active: true } })
        : null;
      fingerprintParts.push(`lodge-bed:${key}:${current ? hashRow(["name", "sortOrder", "active"], current) : "absent"}`);
      items.push({ entity: "lodge-bed", key, action: current ? "update" : "create" });
    }

    // Seasons (key-weak: match by lodge + name).
    for (const raw of readCsv(ctx.files, paths.seasons)) {
      const key = `${slug}/${raw.name}`;
      const current = lodgeId
        ? await ctx.db.season.findFirst({ where: { lodgeId, name: raw.name ?? "" }, select: { name: true, type: true, active: true } })
        : null;
      fingerprintParts.push(`season:${key}:${current ? hashRow(["name", "type", "active"], current) : "absent"}`);
      items.push({ entity: "season", key, action: current ? "update" : "create" });
    }

    // Season rates.
    for (const raw of readCsv(ctx.files, paths.rates)) {
      const key = `${slug}/${raw.seasonName}/${raw.ageTier}/${raw.isMember}`;
      const season = lodgeId
        ? await ctx.db.season.findFirst({ where: { lodgeId, name: raw.seasonName ?? "" }, select: { id: true } })
        : null;
      fingerprintParts.push(`season-rate:${key}:${season ? "present" : "absent"}`);
      items.push({ entity: "season-rate", key, action: season ? "update" : "create" });
    }
  }

  return { items, warnings, fingerprintParts };
}

// ---- Apply -----------------------------------------------------------------

async function applyLodgeConfig(ctx: ApplyContext): Promise<CategoryApplyResult> {
  const result: CategoryApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: 0 };

  // Process lodges folder-by-folder in deterministic (segment) order, each a
  // self-contained unit: lodge → rooms → beds → seasons → season rates.
  for (const segment of lodgeFolderSegments(ctx.files)) {
    const paths = lodgeFolderFiles(segment);
    const descriptor = readLodgeJson(ctx.files, paths.lodge);
    const slug = asStr(descriptor?.slug);
    if (!descriptor || !slug) {
      // Orphan folder (no lodge.json): cannot attach its rows to a lodge.
      result.skipped +=
        readCsv(ctx.files, paths.rooms).length +
        readCsv(ctx.files, paths.beds).length +
        readCsv(ctx.files, paths.seasons).length +
        readCsv(ctx.files, paths.rates).length;
      continue;
    }

    // 1) Lodge (by slug).
    const lodgeData: Record<string, unknown> = {
      name: asStr(descriptor.name) || slug,
      active: coerceBool(descriptor.active),
      travelNote: asNullableStr(descriptor.travelNote),
    };
    if ("doorCode" in descriptor) lodgeData.doorCode = asNullableStr(descriptor.doorCode);
    const existingLodge = await ctx.tx.lodge.findUnique({ where: { slug }, select: { id: true } });
    const lodge = await ctx.tx.lodge.upsert({
      where: { slug },
      create: { slug, ...(lodgeData as { name: string }) },
      update: lodgeData,
      select: { id: true },
    });
    if (existingLodge) result.updated += 1;
    else result.created += 1;
    const lodgeId = lodge.id;

    // 2) Rooms (by lodgeId + name).
    for (const raw of readCsv(ctx.files, paths.rooms)) {
      const name = raw.name ?? "";
      if (!name) { result.skipped += 1; continue; }
      const data = { sortOrder: coerceInt(raw.sortOrder, 0), active: coerceBool(raw.active), notes: raw.notes || null };
      const existing = await ctx.tx.lodgeRoom.findUnique({ where: { lodgeId_name: { lodgeId, name } }, select: { id: true } });
      await ctx.tx.lodgeRoom.upsert({ where: { lodgeId_name: { lodgeId, name } }, create: { lodgeId, name, ...data }, update: data });
      if (existing) result.updated += 1;
      else result.created += 1;
    }

    // 3) Beds (by roomId + name).
    for (const raw of readCsv(ctx.files, paths.beds)) {
      const room = await ctx.tx.lodgeRoom.findUnique({ where: { lodgeId_name: { lodgeId, name: raw.roomName ?? "" } }, select: { id: true } });
      if (!room) { result.skipped += 1; continue; }
      const name = raw.name ?? "";
      if (!name) { result.skipped += 1; continue; }
      const data = { sortOrder: coerceInt(raw.sortOrder, 0), active: coerceBool(raw.active) };
      const existing = await ctx.tx.lodgeBed.findUnique({ where: { roomId_name: { roomId: room.id, name } }, select: { id: true } });
      await ctx.tx.lodgeBed.upsert({ where: { roomId_name: { roomId: room.id, name } }, create: { roomId: room.id, name, ...data }, update: data });
      if (existing) result.updated += 1;
      else result.created += 1;
    }

    // 4) Seasons (key-weak: match/create by lodge + name).
    const seasonIdByName = new Map<string, string>();
    for (const raw of readCsv(ctx.files, paths.seasons)) {
      const name = raw.name ?? "";
      if (!name) { result.skipped += 1; continue; }
      const data = { type: raw.type as never, startDate: fromDateStr(raw.startDate), endDate: fromDateStr(raw.endDate), active: coerceBool(raw.active) };
      const existing = await ctx.tx.season.findFirst({ where: { lodgeId, name }, select: { id: true } });
      if (existing) {
        await ctx.tx.season.update({ where: { id: existing.id }, data });
        seasonIdByName.set(name, existing.id);
        result.updated += 1;
      } else {
        const created = await ctx.tx.season.create({ data: { lodgeId, name, ...data }, select: { id: true } });
        seasonIdByName.set(name, created.id);
        result.created += 1;
      }
    }

    // 5) Season rates (by seasonId + ageTier + isMember).
    for (const raw of readCsv(ctx.files, paths.rates)) {
      let seasonId = seasonIdByName.get(raw.seasonName ?? "");
      if (!seasonId) {
        const season = await ctx.tx.season.findFirst({ where: { lodgeId, name: raw.seasonName ?? "" }, select: { id: true } });
        seasonId = season?.id;
      }
      if (!seasonId) { result.skipped += 1; continue; }
      const ageTier = raw.ageTier as never;
      const isMember = coerceBool(raw.isMember);
      const data = { pricePerNightCents: coerceInt(raw.pricePerNightCents, 0) };
      const existing = await ctx.tx.seasonRate.findUnique({ where: { seasonId_ageTier_isMember: { seasonId, ageTier, isMember } }, select: { id: true } });
      await ctx.tx.seasonRate.upsert({ where: { seasonId_ageTier_isMember: { seasonId, ageTier, isMember } }, create: { seasonId, ageTier, isMember, ...data }, update: data });
      if (existing) result.updated += 1;
      else result.created += 1;
    }
  }

  return result;
}

export const lodgeConfigImporter: CategoryImporter = {
  category: "lodge-config",
  plan: planLodgeConfig,
  apply: applyLodgeConfig,
};
