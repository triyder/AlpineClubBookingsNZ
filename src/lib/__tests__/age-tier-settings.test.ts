/**
 * Tests for Issue 13 & 14: Age tier boundaries and configurable settings
 */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  computeAgeTierWithSettings,
  AGE_TIER_DEFAULTS,
  getSeasonStartDate,
  computeAge,
  invalidateAgeTierCache,
  normalizeAgeTierSettings,
  type AgeTierSettingData,
} from "../age-tier";

// ---------------------------------------------------------------------------
// computeAgeTierWithSettings unit tests
// ---------------------------------------------------------------------------

describe("computeAgeTierWithSettings — TAC default boundaries", () => {
  const ref2026 = getSeasonStartDate(2026); // April 1, 2026

  it("INFANT: age 0-4", () => {
    // Newborn-ish
    expect(
      computeAgeTierWithSettings(new Date("2025-06-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
    // Age 4 exactly
    expect(
      computeAgeTierWithSettings(new Date("2021-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("INFANT");
  });

  it("CHILD: age 5-9", () => {
    // Age 5 exactly
    expect(
      computeAgeTierWithSettings(new Date("2021-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
    // Age 9 exactly
    expect(
      computeAgeTierWithSettings(new Date("2016-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
  });

  it("YOUTH: age 10-17", () => {
    // Exactly 10
    expect(
      computeAgeTierWithSettings(new Date("2016-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
    // Age 17 (day before 18th birthday)
    expect(
      computeAgeTierWithSettings(new Date("2008-04-02"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
  });

  it("ADULT: age 18+", () => {
    // Exactly 18
    expect(
      computeAgeTierWithSettings(new Date("2008-04-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("ADULT");
    // Age 40
    expect(
      computeAgeTierWithSettings(new Date("1985-01-01"), ref2026, AGE_TIER_DEFAULTS)
    ).toBe("ADULT");
  });

  it("sets default booking subscription requirement per tier", () => {
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "INFANT")
        ?.subscriptionRequiredForBooking
    ).toBe(false);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "CHILD")
        ?.subscriptionRequiredForBooking
    ).toBe(false);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "YOUTH")
        ?.subscriptionRequiredForBooking
    ).toBe(true);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "ADULT")
        ?.subscriptionRequiredForBooking
    ).toBe(true);
  });

  it("sets default family request member creation policy per tier", () => {
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "INFANT")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(true);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "CHILD")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(true);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "YOUTH")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(false);
    expect(
      AGE_TIER_DEFAULTS.find((setting) => setting.tier === "ADULT")
        ?.familyGroupRequestCreateMemberAllowed
    ).toBe(false);
  });
});

describe("computeAgeTierWithSettings — custom settings", () => {
  const ref = new Date("2026-04-01");

  it("respects custom boundaries", () => {
    const custom: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 12, label: "Child (under 13)", sortOrder: 1 },
      { tier: "YOUTH", minAge: 13, maxAge: 17, label: "Youth (13-17)", sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 3 },
    ];
    // Age 11 on April 1 2026 (Malia DOB 2014-08-28)
    expect(
      computeAgeTierWithSettings(new Date("2014-08-28"), ref, custom)
    ).toBe("CHILD"); // under 13 with old boundaries
  });

  it("falls back to ADULT if no range matches", () => {
    // Weird settings missing ranges — shouldn't happen in prod but defensive
    const weirdSettings: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 5, label: "Child", sortOrder: 1 },
      // gap: 6-17 not covered
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 2 },
    ];
    // Age 10 -> not matched by CHILD (max 5) and not matched by ADULT (min 18)
    // falls back to ADULT
    expect(
      computeAgeTierWithSettings(new Date("2016-01-01"), ref, weirdSettings)
    ).toBe("ADULT");
  });
});

// ---------------------------------------------------------------------------
// Season start date reference (Issue 13 core fix)
// ---------------------------------------------------------------------------

describe("Season start date as reference", () => {
  it("April 1 of season year is used for classification", () => {
    const maliaDOB = new Date("2014-08-28");
    // On April 1 2026 she is 11 (turns 12 in August)
    expect(computeAge(maliaDOB, getSeasonStartDate(2026))).toBe(11);
    expect(
      computeAgeTierWithSettings(maliaDOB, getSeasonStartDate(2026), AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
  });

  it("someone turning 10 on March 31 is YOUTH for that season", () => {
    // Born March 31 2016: on April 1 2026 they are already 10 (birthday was yesterday)
    const dob = new Date("2016-03-31");
    expect(computeAge(dob, getSeasonStartDate(2026))).toBe(10);
    expect(
      computeAgeTierWithSettings(dob, getSeasonStartDate(2026), AGE_TIER_DEFAULTS)
    ).toBe("YOUTH");
  });

  it("someone born April 2 is still CHILD on April 1 of the 10th-birthday year", () => {
    // Born April 2 2016: on April 1 2026 they are 9 (turns 10 the next day)
    const dob = new Date("2016-04-02");
    expect(computeAge(dob, getSeasonStartDate(2026))).toBe(9);
    expect(
      computeAgeTierWithSettings(dob, getSeasonStartDate(2026), AGE_TIER_DEFAULTS)
    ).toBe("CHILD");
  });

  it("getSeasonStartDate returns April 1 for any season year", () => {
    [2024, 2025, 2026, 2027].forEach((year) => {
      const d = getSeasonStartDate(year);
      expect(d.getFullYear()).toBe(year);
      expect(d.getMonth()).toBe(3); // April
      expect(d.getDate()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation
// ---------------------------------------------------------------------------

describe("invalidateAgeTierCache", () => {
  it("can be called without error", () => {
    expect(() => invalidateAgeTierCache()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getAgeTierSettings fallback
// ---------------------------------------------------------------------------

describe("getAgeTierSettings fallback", () => {
  beforeEach(() => {
    invalidateAgeTierCache();
    vi.resetModules();
  });

  it("falls back to AGE_TIER_DEFAULTS when DB is unavailable", async () => {
    // Mock prisma to throw
    vi.doMock("../prisma", () => ({
      prisma: {
        ageTierSetting: {
          findMany: vi.fn().mockRejectedValue(new Error("DB unavailable")),
        },
      },
    }));

    const { getAgeTierSettings, AGE_TIER_DEFAULTS: defaults } = await import("../age-tier");
    const result = await getAgeTierSettings();
    expect(result).toEqual(defaults);
  });

  it("normalizes the legacy 3-tier DB rows to the INFANT-aware defaults", async () => {
    vi.doMock("../prisma", () => ({
      prisma: {
        ageTierSetting: {
          findMany: vi.fn().mockResolvedValue([
            { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child (under 10)", sortOrder: 1 },
            { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
            { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3 },
          ]),
        },
      },
    }));

    const { getAgeTierSettings, AGE_TIER_DEFAULTS: defaults } = await import("../age-tier");
    const result = await getAgeTierSettings();
    expect(result).toEqual(defaults);
  });
});

// ---------------------------------------------------------------------------
// Hard-coded default net (#1983): DB is the sole runtime source; AGE_TIER_DEFAULTS
// no longer derives from config/club.json. Pin the exact array so the fallback
// can never silently drift with an edited/absent config file.
// ---------------------------------------------------------------------------

describe("AGE_TIER_DEFAULTS — hard-coded 4-tier TAC shape (config-independent)", () => {
  it("equals the post-20260412190000 / club.example.json TAC default, byte-for-byte", () => {
    expect(AGE_TIER_DEFAULTS).toEqual([
      {
        tier: "INFANT",
        minAge: 0,
        maxAge: 4,
        label: "Infant (under 5)",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 5,
        maxAge: 9,
        label: "Child (5-9)",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 1,
      },
      {
        tier: "YOUTH",
        minAge: 10,
        maxAge: 17,
        label: "Youth (10-17)",
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 2,
      },
      {
        tier: "ADULT",
        minAge: 18,
        maxAge: null,
        label: "Adult (18+)",
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 3,
      },
    ]);
  });

  it("equals the tiers config/club.example.json resolves (byte-for-byte, catches drift in the canonical repo)", () => {
    // The demotion is only safe if the hard-coded net matches what the CANONICAL
    // config/club.example.json ageTiers resolve to (the seed contract). Pin the
    // assertion to the example file EXPLICITLY — not the effective `clubConfig`
    // singleton — so a fork booting a valid custom config/club.json never gets a
    // false CI failure, while the canonical repo still fails loudly if
    // club.example.json ageTiers ever drift from the hard-coded default.
    const examplePath = path.join(process.cwd(), "config", "club.example.json");
    const exampleConfig = JSON.parse(
      fs.readFileSync(examplePath, "utf8"),
    ) as {
      ageTiers: Array<{
        id: string;
        minAge: number;
        maxAge: number | null;
        label: string;
        subscriptionRequiredForBooking: boolean;
        familyGroupRequestCreateMemberAllowed: boolean;
      }>;
    };
    const exampleDerived = exampleConfig.ageTiers.map((tier, sortOrder) => ({
      tier: tier.id,
      minAge: tier.minAge,
      maxAge: tier.maxAge,
      label: tier.label,
      subscriptionRequiredForBooking: tier.subscriptionRequiredForBooking,
      familyGroupRequestCreateMemberAllowed:
        tier.familyGroupRequestCreateMemberAllowed,
      sortOrder,
    }));
    expect(AGE_TIER_DEFAULTS).toEqual(exampleDerived);
  });

  it("resolves an EMPTY table to the hard-coded default (no config dependency)", () => {
    // An empty AgeTierSetting table (fresh fork before self-heal / seed) must
    // still yield valid tiers so age classification never breaks.
    expect(normalizeAgeTierSettings([])).toEqual(AGE_TIER_DEFAULTS);
  });
});

describe("normalizeAgeTierSettings — populated non-legacy table is byte-identical", () => {
  // The exact tokoroa/TAC-shaped rows a migrated DB holds after
  // 20260412190000. Resolution must return them untouched (no fallback) so
  // pricing is byte-identical before/after the config-fallback removal.
  const postMigrationRows: AgeTierSettingData[] = [
    {
      tier: "INFANT",
      minAge: 0,
      maxAge: 4,
      label: "Infant (under 5)",
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: 0,
    },
    {
      tier: "CHILD",
      minAge: 5,
      maxAge: 9,
      label: "Child (5-9)",
      subscriptionRequiredForBooking: false,
      familyGroupRequestCreateMemberAllowed: true,
      sortOrder: 1,
    },
    {
      tier: "YOUTH",
      minAge: 10,
      maxAge: 17,
      label: "Youth (10-17)",
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      sortOrder: 2,
    },
    {
      tier: "ADULT",
      minAge: 18,
      maxAge: null,
      label: "Adult (18+)",
      subscriptionRequiredForBooking: true,
      familyGroupRequestCreateMemberAllowed: false,
      sortOrder: 3,
    },
  ];

  it("returns the DB rows unchanged (not the fallback)", () => {
    expect(normalizeAgeTierSettings(postMigrationRows)).toEqual(postMigrationRows);
  });

  it("a migrated 4-tier DB does NOT match the legacy shape (CHILD is 5-9, not 0-9)", () => {
    // The legacy-3-tier trap: because the migration shifts CHILD to 5-9 and adds
    // INFANT, a migrated DB can never re-enter the legacy fallback branch. Prove
    // it by confirming the rows survive normalization identically.
    const normalized = normalizeAgeTierSettings(postMigrationRows);
    expect(normalized.find((t) => t.tier === "CHILD")?.minAge).toBe(5);
    expect(normalized).not.toBe(AGE_TIER_DEFAULTS); // distinct array (clone)
    expect(normalized).toEqual(postMigrationRows);
  });
});

describe("normalizeAgeTierSettings", () => {
  it("legacy 3-tier DB resolves to the post-20260412190000 TAC values (no silent pricing change)", () => {
    // A genuinely-unmigrated DB in the legacy shape (CHILD 0-9 / YOUTH / ADULT)
    // falls back to the hard-coded default, which equals exactly what the
    // 20260412190000 backfill would have written: INFANT 0-4, CHILD 5-9,
    // YOUTH 10-17, ADULT 18+.
    const legacyRows: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child (under 10)", sortOrder: 1 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3 },
    ];

    const resolved = normalizeAgeTierSettings(legacyRows);
    expect(resolved).toEqual([
      { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant (under 5)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 0 },
      { tier: "CHILD", minAge: 5, maxAge: 9, label: "Child (5-9)", subscriptionRequiredForBooking: false, familyGroupRequestCreateMemberAllowed: true, sortOrder: 1 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", subscriptionRequiredForBooking: true, familyGroupRequestCreateMemberAllowed: false, sortOrder: 3 },
    ]);
  });

  it("rewrites the legacy 3-tier settings to the default 4-tier layout", () => {
    const legacyRows: AgeTierSettingData[] = [
      { tier: "CHILD", minAge: 0, maxAge: 9, label: "Child (under 10)", sortOrder: 1 },
      { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
      { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult", sortOrder: 3 },
    ];

    expect(normalizeAgeTierSettings(legacyRows)).toEqual(AGE_TIER_DEFAULTS);
  });

  it("preserves custom 4-tier settings", () => {
    const customRows: AgeTierSettingData[] = [
      {
        tier: "INFANT",
        minAge: 0,
        maxAge: 2,
        label: "Baby (0-2)",
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 3,
        maxAge: 12,
        label: "Child (3-12)",
        sortOrder: 1,
      },
      {
        tier: "YOUTH",
        minAge: 13,
        maxAge: 17,
        label: "Teen (13-17)",
        sortOrder: 2,
      },
      {
        tier: "ADULT",
        minAge: 18,
        maxAge: null,
        label: "Adult (18+)",
        sortOrder: 3,
      },
    ];

    expect(normalizeAgeTierSettings(customRows)).toEqual(
      customRows.map((row) => ({
        ...row,
        subscriptionRequiredForBooking: true,
        familyGroupRequestCreateMemberAllowed: false,
      }))
    );
  });

  it("preserves explicit family request member creation settings", () => {
    const customRows: AgeTierSettingData[] = [
      {
        tier: "INFANT",
        minAge: 0,
        maxAge: 4,
        label: "Infant",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: true,
        sortOrder: 0,
      },
      {
        tier: "CHILD",
        minAge: 5,
        maxAge: 9,
        label: "Child",
        subscriptionRequiredForBooking: false,
        familyGroupRequestCreateMemberAllowed: false,
        sortOrder: 1,
      },
    ];

    expect(normalizeAgeTierSettings(customRows)).toEqual(customRows);
  });
});

// ---------------------------------------------------------------------------
// Admin API validation logic (unit-testable business rules)
// ---------------------------------------------------------------------------

describe("Age tier contiguity validation rules", () => {
  it("recognises a gap between tiers as invalid", () => {
    // Simulates the validation: minAge of next must equal maxAge of current + 1
    const sorted = [
      { tier: "CHILD", minAge: 0, maxAge: 8 },
      { tier: "YOUTH", minAge: 10, maxAge: 17 }, // gap: 9 is uncovered
      { tier: "ADULT", minAge: 18, maxAge: null },
    ];
    let hasGap = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const nxt = sorted[i + 1];
      if (cur.maxAge !== null && cur.maxAge + 1 !== nxt.minAge) {
        hasGap = true;
        break;
      }
    }
    expect(hasGap).toBe(true);
  });

  it("recognises contiguous tiers as valid", () => {
    const sorted = [
      { tier: "CHILD", minAge: 0, maxAge: 9 },
      { tier: "YOUTH", minAge: 10, maxAge: 17 },
      { tier: "ADULT", minAge: 18, maxAge: null },
    ];
    let hasGap = false;
    for (let i = 0; i < sorted.length - 1; i++) {
      const cur = sorted[i];
      const nxt = sorted[i + 1];
      if (cur.maxAge !== null && cur.maxAge + 1 !== nxt.minAge) {
        hasGap = true;
        break;
      }
    }
    expect(hasGap).toBe(false);
  });
});
