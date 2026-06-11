import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacityStatus: vi.fn().mockResolvedValue({
    capacity: 29,
    source: "club_config",
    bedAllocationEnabled: false,
    activeBedCount: 0,
    fallbackCapacity: 29,
  }),
}));

import {
  BedAllocationAdminError,
  MAX_BED_ALLOCATION_RANGE_NIGHTS,
  buildBedAllocationWarnings,
  parseBedAllocationDateRange,
  updateBedAllocationBed,
} from "@/lib/admin-bed-allocation";
import { parseDateOnly } from "@/lib/date-only";

function readRepoFile(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("admin bed allocation", () => {
  it("validates date-only allocation ranges", () => {
    expect(
      parseBedAllocationDateRange({
        from: "2026-07-01",
        to: "2026-07-08",
      }),
    ).toMatchObject({
      fromDate: "2026-07-01",
      toDate: "2026-07-08",
    });

    expect(() =>
      parseBedAllocationDateRange({
        from: "2026-07-08",
        to: "2026-07-01",
      }),
    ).toThrow(BedAllocationAdminError);

    expect(() =>
      parseBedAllocationDateRange({
        from: "2026-07-01",
        to: "2026-08-15",
      }),
    ).toThrow(
      `Date range cannot exceed ${MAX_BED_ALLOCATION_RANGE_NIGHTS} nights`,
    );
  });

  it("warns when bookings are split or minors are without a booking adult", () => {
    const warnings = buildBedAllocationWarnings({
      allocations: [
        {
          id: "allocation-1",
          bookingId: "booking-1",
          bookingGuestId: "adult-1",
          guestName: "Adult One",
          guestAgeTier: "ADULT",
          roomId: "room-a",
          roomName: "Room A",
          bedId: "bed-a1",
          bedName: "A1",
          stayDate: "2026-07-01",
          source: "MANUAL",
          approvedAt: null,
          approvedByName: null,
        },
        {
          id: "allocation-2",
          bookingId: "booking-1",
          bookingGuestId: "child-1",
          guestName: "Child One",
          guestAgeTier: "CHILD",
          roomId: "room-b",
          roomName: "Room B",
          bedId: "bed-b1",
          bedName: "B1",
          stayDate: "2026-07-01",
          source: "MANUAL",
          approvedAt: null,
          approvedByName: null,
        },
      ],
    });

    expect(warnings.map((warning) => warning.type)).toEqual([
      "BOOKING_SPLIT",
      "MINOR_WITHOUT_BOOKING_ADULT",
    ]);
  });

  it("keeps bed allocation routes feature gated", () => {
    const featureRoutes = readRepoFile("src/config/feature-routes.ts");
    const sidebar = readRepoFile("src/components/admin-sidebar.tsx");

    expect(featureRoutes).toContain('flag: "bedAllocation"');
    expect(featureRoutes).toContain('"/admin/bed-allocation"');
    expect(featureRoutes).toContain('"/admin/rooms-beds"');
    expect(featureRoutes).toContain('"/api/admin/bed-allocation"');
    expect(sidebar).toContain('href: "/admin/bed-allocation"');
    expect(sidebar).toContain('href: "/admin/rooms-beds"');
  });

  it("blocks deactivating a bed with future allocations", async () => {
    const update = vi.fn();
    const db = {
      bedAllocation: {
        findMany: vi.fn().mockResolvedValue([
          { stayDate: parseDateOnly("2026-07-01") },
          { stayDate: parseDateOnly("2026-07-03") },
        ]),
      },
      lodgeBed: {
        update,
      },
    };

    await expect(
      updateBedAllocationBed({
        id: "bed-1",
        active: false,
        db: db as never,
      }),
    ).rejects.toThrow(
      "Cannot deactivate this bed while future allocations exist on 2026-07-01, 2026-07-03.",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("adds persistent admin-only mode settings", () => {
    const schema = readRepoFile("prisma/schema.prisma");
    const migration = readRepoFile(
      "prisma/migrations/20260607142000_add_bed_allocation_settings/migration.sql",
    );

    expect(schema).toContain("model BedAllocationSettings");
    expect(schema).toContain("autoAllocationEnabled Boolean");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS "BedAllocationSettings"');
    expect(migration).toContain(
      'INSERT INTO "BedAllocationSettings" ("id")',
    );
  });
});
