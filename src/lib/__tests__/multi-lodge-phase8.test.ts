import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 8 (docs/multi-lodge/implementation-plan.md): booking-flow lodge
// threading and per-booking lodge identity in emails.

const mocks = vi.hoisted(() => ({
  lodgeFindFirst: vi.fn(),
  lodgeFindUnique: vi.fn(),
  lodgeRoomFindUnique: vi.fn(),
  emailMessageSettingFindUnique: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lodge: {
      findFirst: mocks.lodgeFindFirst,
      findUnique: mocks.lodgeFindUnique,
    },
    lodgeRoom: {
      findUnique: mocks.lodgeRoomFindUnique,
    },
    emailMessageSetting: {
      findUnique: mocks.emailMessageSettingFindUnique,
    },
  },
}));

import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { loadEmailMessageSettingsForLodge } from "@/lib/email-message-settings";
import {
  BookingLodgeError,
  createWaitlistedBooking,
  type WaitlistedBookingInput,
} from "@/lib/booking-create";

const prismaMockDb = {
  lodge: {
    findFirst: mocks.lodgeFindFirst,
    findUnique: mocks.lodgeFindUnique,
  },
};

describe("resolveOptionalActiveLodgeId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the requested lodge when it exists and is active", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });

    const resolved = await resolveOptionalActiveLodgeId(
      prismaMockDb as never,
      "lodge-2",
    );

    expect(resolved).toBe("lodge-2");
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("returns null for an unknown or inactive requested lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    expect(
      await resolveOptionalActiveLodgeId(prismaMockDb as never, "lodge-2"),
    ).toBeNull();

    mocks.lodgeFindUnique.mockResolvedValue(null);
    expect(
      await resolveOptionalActiveLodgeId(prismaMockDb as never, "lodge-x"),
    ).toBeNull();
  });

  it("falls back to the default lodge when none is requested", async () => {
    mocks.lodgeFindFirst.mockResolvedValue({ id: "lodge-default" });

    const resolved = await resolveOptionalActiveLodgeId(
      prismaMockDb as never,
      undefined,
    );

    expect(resolved).toBe("lodge-default");
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
  });
});

describe("loadEmailMessageSettingsForLodge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The singleton now persists only club-level fields; lodge identity resolves
    // from the Lodge table.
    mocks.emailMessageSettingFindUnique.mockResolvedValue({
      clubName: "Test Club",
      bookingsName: "Test Club - Bookings",
      emailFromName: "Test Club",
      supportEmail: "support@example.org",
      contactEmail: "contact@example.org",
      publicUrl: "https://example.org",
    });
  });

  it("resolves the default lodge when no lodge is given", async () => {
    mocks.lodgeFindFirst.mockResolvedValue({
      name: "Default Lodge",
      travelNote: "Follow the valley road.",
      doorCode: "1234",
    });

    const settings = await loadEmailMessageSettingsForLodge(null);

    expect(settings.lodgeName).toBe("Default Lodge");
    expect(settings.lodgeTravelNote).toBe("Follow the valley road.");
    expect(settings.doorCode).toBe("1234");
    // The default lodge is resolved via findFirst, not a keyed findUnique.
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
    expect(mocks.lodgeFindFirst).toHaveBeenCalled();
  });

  it("resolves the isDefault-flagged lodge ahead of the oldest active lodge", async () => {
    // Mirror contract (lodges.ts getDefaultLodgeId / SQL default_lodge_id() as
    // replaced by 20260709120000): the flagged lodge wins even when an older
    // active lodge exists. Pin the ordering so the three copies cannot drift.
    mocks.lodgeFindFirst.mockImplementation(
      async ({ where }: { where?: { isDefault?: boolean; active?: boolean } }) => {
        if (where?.isDefault) {
          return {
            name: "Flagged Lodge",
            travelNote: "Flagged route.",
            doorCode: "5555",
          };
        }
        return {
          name: "Oldest Active Lodge",
          travelNote: "Old route.",
          doorCode: "1111",
        };
      },
    );

    const settings = await loadEmailMessageSettingsForLodge(null);

    expect(settings.lodgeName).toBe("Flagged Lodge");
    expect(settings.doorCode).toBe("5555");
    expect(mocks.lodgeFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isDefault: true } }),
    );
  });

  it("falls back to config defaults, without throwing, when no lodge rows exist", async () => {
    mocks.lodgeFindFirst.mockResolvedValue(null);

    const settings = await loadEmailMessageSettingsForLodge(null);

    // Config defaults on a fresh pre-seed install; never throws.
    expect(settings.lodgeName).toMatch(/Lodge$/);
    expect(settings.lodgeTravelNote.length).toBeGreaterThan(0);
    expect(settings.doorCode).toBeNull();
  });

  it("prefers an explicit lodgeId over the default lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({
      name: "River Lodge",
      travelNote: "Cross the swing bridge.",
      doorCode: "2222",
    });

    const settings = await loadEmailMessageSettingsForLodge("lodge-2");

    expect(settings.lodgeName).toBe("River Lodge");
    expect(settings.lodgeTravelNote).toBe("Cross the swing bridge.");
    expect(settings.doorCode).toBe("2222");
    // The explicit lodge wins; the default-lodge findFirst is not consulted.
    expect(mocks.lodgeFindFirst).not.toHaveBeenCalled();
  });

  it("never leaks a door code to a lodge without one", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({
      name: "River Lodge",
      travelNote: null,
      doorCode: null,
    });

    const settings = await loadEmailMessageSettingsForLodge("lodge-2");

    expect(settings.lodgeName).toBe("River Lodge");
    // A lodge without its own door code means no door code — never another
    // lodge's.
    expect(settings.doorCode).toBeNull();
  });

  it("falls back to the default lodge when the explicit lodge is missing", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);
    mocks.lodgeFindFirst.mockResolvedValue({
      name: "Default Lodge",
      travelNote: null,
      doorCode: "9999",
    });

    const settings = await loadEmailMessageSettingsForLodge("lodge-gone");

    expect(settings.lodgeName).toBe("Default Lodge");
    expect(settings.doorCode).toBe("9999");
  });

  it("applies singleton club-field overrides alongside Lodge-sourced identity", async () => {
    mocks.emailMessageSettingFindUnique.mockResolvedValue({
      clubName: "River Valley Alpine Club",
      bookingsName: "River Valley - Bookings",
      emailFromName: "River Valley",
      supportEmail: "help@example.org",
      contactEmail: "contact@example.org",
      publicUrl: "https://rv.example.org",
    });
    mocks.lodgeFindFirst.mockResolvedValue({
      name: "Summit Hut",
      travelNote: "Chains required.",
      doorCode: "4321",
    });

    const settings = await loadEmailMessageSettingsForLodge(null);

    // Club fields from the singleton...
    expect(settings.clubName).toBe("River Valley Alpine Club");
    expect(settings.bookingsName).toBe("River Valley - Bookings");
    // ...alongside Lodge-sourced identity.
    expect(settings.lodgeName).toBe("Summit Hut");
    expect(settings.doorCode).toBe("4321");
  });
});

describe("booking creation lodge integrity", () => {
  const baseInput = {
    effectiveMemberId: "member-1",
    isOnBehalf: false,
    sessionUserId: "member-1",
    checkIn: new Date("2026-08-10"),
    checkOut: new Date("2026-08-12"),
    guests: [
      {
        firstName: "Alice",
        lastName: "Smith",
        ageTier: "ADULT",
        isMember: true,
      },
    ],
  } as unknown as WaitlistedBookingInput;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unknown or inactive lodge before writing anything", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);

    await expect(
      createWaitlistedBooking({ ...baseInput, lodgeId: "lodge-x" }),
    ).rejects.toThrow(BookingLodgeError);
  });

  it("rejects a requested room that belongs to a different lodge", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    mocks.lodgeRoomFindUnique.mockResolvedValue({ lodgeId: "lodge-1" });

    await expect(
      createWaitlistedBooking({
        ...baseInput,
        lodgeId: "lodge-2",
        requestedRoomId: "room-1",
      }),
    ).rejects.toThrow("Requested room belongs to a different lodge");
  });
});
