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
    mocks.emailMessageSettingFindUnique.mockResolvedValue({
      clubName: "Test Club",
      bookingsName: "Test Club - Bookings",
      lodgeName: "Singleton Lodge",
      emailFromName: "Test Club",
      supportEmail: "support@example.org",
      contactEmail: "contact@example.org",
      publicUrl: "https://example.org",
      lodgeTravelNote: "Singleton travel note",
      doorCode: "1111",
    });
  });

  it("keeps the singleton values when no lodge is given", async () => {
    const settings = await loadEmailMessageSettingsForLodge(null);

    expect(settings.lodgeName).toBe("Singleton Lodge");
    expect(settings.doorCode).toBe("1111");
    expect(mocks.lodgeFindUnique).not.toHaveBeenCalled();
  });

  it("overlays the booking lodge's name, travel note, and door code", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({
      name: "River Lodge",
      travelNote: "Cross the swing bridge.",
      doorCode: "2222",
    });

    const settings = await loadEmailMessageSettingsForLodge("lodge-2");

    expect(settings.lodgeName).toBe("River Lodge");
    expect(settings.lodgeTravelNote).toBe("Cross the swing bridge.");
    expect(settings.doorCode).toBe("2222");
  });

  it("never leaks the singleton door code to a lodge without one", async () => {
    mocks.lodgeFindUnique.mockResolvedValue({
      name: "River Lodge",
      travelNote: null,
      doorCode: null,
    });

    const settings = await loadEmailMessageSettingsForLodge("lodge-2");

    expect(settings.lodgeName).toBe("River Lodge");
    // Missing lodge door code means no door code — not lodge A's from the
    // singleton.
    expect(settings.doorCode).toBeNull();
  });

  it("keeps the singleton values when the lodge row is missing", async () => {
    mocks.lodgeFindUnique.mockResolvedValue(null);

    const settings = await loadEmailMessageSettingsForLodge("lodge-gone");

    expect(settings.lodgeName).toBe("Singleton Lodge");
    expect(settings.doorCode).toBe("1111");
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
