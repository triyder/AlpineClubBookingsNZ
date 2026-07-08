import { describe, expect, it, vi } from "vitest";
import { strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import { buildConfigExport } from "@/lib/config-transfer/export";
import { buildImportPlan } from "@/lib/config-transfer/import";
import { readBundle } from "@/lib/config-transfer/bundle";
import { parseCsv } from "@/lib/config-transfer/csv";
import type { ReadDb } from "@/lib/config-transfer/import-types";

function sourceDb(): ReadDb {
  return {
    lodge: {
      findMany: vi.fn().mockResolvedValue([
        { slug: "main", name: "Main Lodge", active: true, travelNote: "Turn left", doorCode: "9999" },
      ]),
    },
    lodgeRoom: {
      findMany: vi.fn().mockResolvedValue([
        { name: "Bunk A", sortOrder: 1, active: true, notes: null, lodge: { slug: "main" } },
      ]),
    },
    lodgeBed: {
      findMany: vi.fn().mockResolvedValue([
        { name: "A1", sortOrder: 1, active: true, room: { name: "Bunk A", lodge: { slug: "main" } } },
      ]),
    },
    season: {
      findMany: vi.fn().mockResolvedValue([
        {
          name: "Winter",
          type: "WINTER",
          startDate: new Date("2026-06-01T00:00:00.000Z"),
          endDate: new Date("2026-09-01T00:00:00.000Z"),
          active: true,
          lodge: { slug: "main" },
        },
      ]),
    },
    seasonRate: {
      findMany: vi.fn().mockResolvedValue([
        {
          ageTier: "ADULT",
          isMember: true,
          pricePerNightCents: 5000,
          season: { name: "Winter", lodge: { slug: "main" } },
        },
      ]),
    },
    lodgeInstruction: { findMany: vi.fn().mockResolvedValue([]) },
    choreTemplate: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as ReadDb;
}

function emptyTargetDb(): ReadDb {
  return {
    lodge: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    lodgeRoom: { findUnique: vi.fn().mockResolvedValue(null) },
    lodgeBed: { findUnique: vi.fn().mockResolvedValue(null) },
    season: { findFirst: vi.fn().mockResolvedValue(null) },
    seasonRate: { findUnique: vi.fn().mockResolvedValue(null) },
    lodgeInstruction: { findFirst: vi.fn().mockResolvedValue(null) },
    choreTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
    xeroToken: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as ReadDb;
}

async function exportLodges(includeDoorCodes: boolean) {
  return buildConfigExport({
    db: sourceDb(),
    categories: ["lodge-config"],
    includeDoorCodes,
    appVersion: "0.10.1",
    prismaMigration: null,
    sourceXeroTenantId: null,
    generatedAt: "2026-07-08T00:00:00.000Z",
  });
}

describe("config-transfer lodge-config", () => {
  it("exports lodges/rooms/beds with FKs flattened to natural keys", async () => {
    const { zip } = await exportLodges(false);
    const { files } = readBundle(zip);

    const lodges = parseCsv(strFromU8(files.get("lodge-config/lodges.csv")!));
    expect(lodges.rows[0].slug).toBe("main");
    expect(lodges.headers).not.toContain("doorCode"); // opt-in only

    const rooms = parseCsv(strFromU8(files.get("lodge-config/rooms.csv")!));
    expect(rooms.rows[0]).toMatchObject({ lodgeSlug: "main", name: "Bunk A" });

    const beds = parseCsv(strFromU8(files.get("lodge-config/beds.csv")!));
    expect(beds.rows[0]).toMatchObject({
      lodgeSlug: "main",
      roomName: "Bunk A",
      name: "A1",
    });

    const seasons = parseCsv(strFromU8(files.get("lodge-config/seasons.csv")!));
    expect(seasons.rows[0]).toMatchObject({
      lodgeSlug: "main",
      name: "Winter",
      startDate: "2026-06-01",
    });

    const rates = parseCsv(strFromU8(files.get("lodge-config/season-rates.csv")!));
    expect(rates.rows[0]).toMatchObject({
      lodgeSlug: "main",
      seasonName: "Winter",
      ageTier: "ADULT",
      pricePerNightCents: "5000",
    });
  });

  it("includes door codes only when opted in", async () => {
    const { zip } = await exportLodges(true);
    const { files } = readBundle(zip);
    const lodges = parseCsv(strFromU8(files.get("lodge-config/lodges.csv")!));
    expect(lodges.headers).toContain("doorCode");
    expect(lodges.rows[0].doorCode).toBe("9999");
  });

  it("plans all-create against an empty target, warning on rooms before their lodge exists", async () => {
    const { zip } = await exportLodges(false);
    const plan = await buildImportPlan(emptyTargetDb(), zip);
    const cat = plan.categories.find((c) => c.category === "lodge-config")!;
    const actions = Object.fromEntries(
      cat.items.map((i) => [i.entity, i.action]),
    );
    expect(actions["lodge"]).toBe("create");
    expect(actions["lodge-room"]).toBe("create");
    expect(actions["lodge-bed"]).toBe("create");
    expect(cat.warnings.join(" ")).toMatch(/unknown lodge/i);
  });
});
