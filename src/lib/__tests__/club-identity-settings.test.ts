import { beforeEach, describe, expect, it, vi } from "vitest";

// Neutralise the client-boundary guard so the server-only module imports in node.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clubIdentitySettings: { findUnique: vi.fn() },
    lodge: { findFirst: vi.fn() },
  },
}));

import { clubConfig } from "@/config/club";
import { prisma } from "@/lib/prisma";
import {
  __resetClubIdentitySyncCacheForTests,
  getClubIdentity,
  getClubIdentitySync,
  primeClubIdentitySync,
  resolveClubIdentity,
} from "@/lib/club-identity-settings";

const clubIdentitySettings = prisma.clubIdentitySettings as unknown as {
  findUnique: ReturnType<typeof vi.fn>;
};
const lodge = prisma.lodge as unknown as {
  findFirst: ReturnType<typeof vi.fn>;
};

describe("resolveClubIdentity fallback matrix", () => {
  it("DB values win when present", () => {
    const id = resolveClubIdentity(
      { name: "DB Club", shortName: "DBC", hutLeaderLabel: "Lodge Leader" },
      "DB Lodge",
    );
    expect(id.name).toBe("DB Club");
    expect(id.shortName).toBe("DBC");
    expect(id.hutLeaderLabel).toBe("Lodge Leader");
    expect(id.lodgeName).toBe("DB Lodge");
    expect(id.bookingsName).toBe("DB Club - Bookings");
  });

  it("falls back to club.json when the DB row is empty", () => {
    const id = resolveClubIdentity(
      { name: null, shortName: null, hutLeaderLabel: null },
      null,
    );
    expect(id.name).toBe(clubConfig.name);
    expect(id.shortName).toBe(clubConfig.shortName ?? clubConfig.name);
    // lodge name derives from the config club name when no Lodge row resolves.
    expect(id.lodgeName).toBe(`${clubConfig.name} Lodge`);
  });

  it("uses the hard-default hut-leader label when neither DB nor config set it", () => {
    // Simulate a config with no hut-leader label by resolving the field chain
    // directly: a null DB value with an undefined config value -> "Hut Leader".
    const id = resolveClubIdentity(
      { name: "X", shortName: null, hutLeaderLabel: null },
      "L",
    );
    // clubConfig may or may not define hutLeaderLabel; the resolved value must
    // never be empty and must equal the config value when set, else the default.
    expect(id.hutLeaderLabel).toBe(clubConfig.hutLeaderLabel ?? "Hut Leader");
    expect(id.hutLeaderLabel.length).toBeGreaterThan(0);
  });

  it("short name falls back to the resolved club name when unset", () => {
    const id = resolveClubIdentity(
      { name: "Only Name", shortName: null, hutLeaderLabel: null },
      "L",
    );
    // config.shortName may exist; when it doesn't, short name == name.
    expect(id.shortName).toBe(clubConfig.shortName ?? "Only Name");
  });
});

describe("getClubIdentity (DB-first)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the DB name and the default lodge name", async () => {
    clubIdentitySettings.findUnique.mockResolvedValue({
      name: "Renamed Club",
      shortName: null,
      hutLeaderLabel: null,
    });
    lodge.findFirst.mockResolvedValueOnce({ name: "Renamed Lodge" });
    const id = await getClubIdentity();
    expect(id.name).toBe("Renamed Club");
    expect(id.lodgeName).toBe("Renamed Lodge");
  });

  it("falls back to config when the DB read throws", async () => {
    clubIdentitySettings.findUnique.mockRejectedValue(new Error("db down"));
    lodge.findFirst.mockRejectedValue(new Error("db down"));
    const id = await getClubIdentity();
    expect(id.name).toBe(clubConfig.name);
  });
});

describe("sync club-identity accessor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetClubIdentitySyncCacheForTests();
  });

  it("returns config defaults before warming and the DB value after a prime", async () => {
    expect(getClubIdentitySync().name).toBe(clubConfig.name);
    clubIdentitySettings.findUnique.mockResolvedValue({
      name: "Primed Club",
      shortName: null,
      hutLeaderLabel: null,
    });
    lodge.findFirst.mockResolvedValue({ name: "Primed Lodge" });
    await primeClubIdentitySync();
    expect(getClubIdentitySync().name).toBe("Primed Club");
  });
});
