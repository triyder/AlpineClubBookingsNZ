import { describe, expect, it, vi } from "vitest";

import {
  CLUB_TIME_ZONE_FALLBACK,
  CLUB_TIME_ZONE_MAX_LENGTH,
  isValidClubTimeZone,
  listSelectableClubTimeZones,
  normaliseClubTimeZone,
  normaliseClubTimeZoneForPreservation,
  resolveClubTimeZone,
} from "@/lib/club-time-zone";

/**
 * The club-timezone validator and precedence rule (CT-1, #2989; INV-CONFIG-002).
 *
 * The thing under test is a JUDGEMENT — "is this a named place whose
 * daylight-saving rules we can read?" — so the interesting half of this file is
 * the refusals. `Intl` is happy to accept `EST`, `NZ`, `UTC`, `Etc/GMT-14` and
 * `SystemV/EST5`; every one of them must be refused here, because a club's civil
 * time has to be a place, and an abbreviation or a fixed offset makes no promise
 * about which rules next winter's bookings get priced and rostered against.
 *
 * Nothing in this file formats a date, so the frozen test clock is irrelevant to
 * it and no assertion can rot with the calendar.
 */

describe("normaliseClubTimeZone — accepts named IANA zones", () => {
  it.each([
    "Pacific/Auckland",
    "Australia/Sydney",
    "America/New_York",
    "Pacific/Chatham",
  ])("accepts %s and returns it unchanged", (zone) => {
    expect(normaliseClubTimeZone(zone)).toBe(zone);
  });

  it("accepts a three-segment identifier", () => {
    // Three segments are legal IANA and the shape rule must not assume two.
    expect(normaliseClubTimeZone("America/Argentina/Rio_Gallegos")).toBe(
      "America/Argentina/Rio_Gallegos",
    );
  });

  it("normalises a case variant to the runtime's canonical spelling", () => {
    // IANA lookups are case-insensitive, so an operator who types it in lower
    // case has named the right place — but the value STORED must be the
    // canonical spelling, or two installs that mean the same zone hold
    // different strings.
    expect(normaliseClubTimeZone("pacific/auckland")).toBe("Pacific/Auckland");
    expect(normaliseClubTimeZone("PACIFIC/AUCKLAND")).toBe("Pacific/Auckland");
  });

  it("trims surrounding whitespace rather than refusing it", () => {
    // A pasted value routinely carries a leading/trailing space, tab or newline.
    // Those are whitespace, not content: refusing them would reject a perfectly
    // good answer. An INTERIOR newline is a different matter and is refused
    // below.
    expect(normaliseClubTimeZone("  Pacific/Auckland  ")).toBe(
      "Pacific/Auckland",
    );
    expect(normaliseClubTimeZone("\tPacific/Auckland\n")).toBe(
      "Pacific/Auckland",
    );
  });

  it("resolves a deprecated alias that names a real place to a usable zone", () => {
    // `US/Pacific` is a legacy link to an American city zone. What matters is
    // that the RESULT is a valid club zone and is not the alias itself — the
    // canonical spelling is whatever this runtime's ICU calls it, so pinning one
    // string here would fail the suite on an ICU upgrade for no reason.
    const resolved = normaliseClubTimeZone("US/Pacific");
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe("US/Pacific");
    expect(isValidClubTimeZone(resolved)).toBe(true);
    // Idempotent: normalising the canonical answer again changes nothing.
    expect(normaliseClubTimeZone(resolved)).toBe(resolved);
  });

  it("accepts every zone this runtime offers as a choice", () => {
    // The guard that stops a future tightening of the shape rule from excluding
    // real zones: the selector offers `Intl.supportedValuesOf("timeZone")`, so
    // anything in that list MUST validate, or the admin surface would offer a
    // value its own save would reject. (Measured on Node 24: 418 zones, every
    // one containing a "/", none in the Etc/ or SystemV/ namespaces.)
    const offered = Intl.supportedValuesOf("timeZone");
    expect(offered.length).toBeGreaterThan(100);
    const rejected = offered.filter((zone) => !isValidClubTimeZone(zone));
    expect(rejected).toEqual([]);
  });
});

describe("normaliseClubTimeZone — refuses everything that is not a place", () => {
  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a tab and newline only", "\t\n"],
    ["null", null],
    ["undefined", undefined],
  ])("refuses %s", (_label, value) => {
    expect(normaliseClubTimeZone(value)).toBeNull();
  });

  it.each([
    // Abbreviations. `Intl` accepts several of these and silently widens them to
    // a city zone (EST -> America/Panama, NZ -> Pacific/Auckland), which is
    // exactly why the shape is judged BEFORE the runtime probe.
    "NZT",
    "NZST",
    "EST",
    "EST5EDT",
    "PST8PDT",
    "UTC",
    "GMT",
    "Zulu",
    "NZ",
    "Japan",
  ])("refuses the abbreviation or single-word alias %s", (value) => {
    expect(normaliseClubTimeZone(value)).toBeNull();
  });

  it.each([
    // Fixed offsets, in every spelling — including the two `Intl` resolves to
    // themselves, which the shape rule alone would let through.
    "+12:00",
    "-05:00",
    "UTC+12",
    "GMT+12:00",
    "Etc/GMT+12",
    "Etc/GMT-14",
    "Etc/UTC",
    "SystemV/EST5",
  ])("refuses the fixed offset or non-location namespace %s", (value) => {
    expect(normaliseClubTimeZone(value)).toBeNull();
  });

  it.each([
    ["a trailing separator", "Pacific/Auckland/"],
    ["a leading separator", "/Pacific/Auckland"],
    ["an empty middle segment", "Pacific//Auckland"],
    ["a bare separator", "/"],
    ["a segment starting with a digit in first position", "1Pacific/Auckland"],
    ["a space inside", "Pacific/Auck land"],
    // Written as an escape on purpose: a raw NUL byte in a source file makes
    // grep treat it as binary and hides the rest of this list from a reviewer.
    ["a NUL byte inside", "Pacific/Auck\u0000land"],
    ["a newline inside", "Pacific/\nAuckland"],
    ["a carriage return inside", "Pacific/Auck\rland"],
    ["a backslash separator", "Pacific\\Auckland"],
  ])("refuses %s", (_label, value) => {
    expect(normaliseClubTimeZone(value)).toBeNull();
  });

  it("refuses a value longer than the column allows", () => {
    // `ClubTimeSettings.timeZone` is VarChar(64), so a longer value could not be
    // stored anyway; refusing it here means the admin API and the CLI both say
    // so instead of the database failing the insert.
    const overLong = `A/${"b".repeat(CLUB_TIME_ZONE_MAX_LENGTH)}`;
    expect(overLong.length).toBeGreaterThan(CLUB_TIME_ZONE_MAX_LENGTH);
    expect(normaliseClubTimeZone(overLong)).toBeNull();
  });

  it("refuses a shape-valid identifier this runtime does not know", () => {
    // The runtime probe, not the shape rule, is what catches this.
    expect(normaliseClubTimeZone("Pacific/Atlantis")).toBeNull();
  });
});

/**
 * The PRESERVATION validator (CT-1, #2989 review).
 *
 * `normaliseClubTimeZoneForPreservation` exists for exactly two callers — the
 * boot backfill and the seed — and differs from `normaliseClubTimeZone` in one
 * ordering: it probes `Intl` FIRST and judges only the RESOLVED identifier. That
 * asymmetry is the fix, and it is asserted head-on further down; without it the
 * backfill refuses `TZ=GB` and writes `Pacific/Auckland` over a London club.
 *
 * Which zone a value canonicalises to is ICU's business and moves between
 * versions (`Intl.supportedValuesOf` on this runtime holds `Asia/Calcutta` and
 * not `Asia/Kolkata`), so most of what is asserted here are PROPERTIES: the
 * result is a valid club zone, and it keeps the same civil time as the value the
 * deployment was actually running on. Only the mappings that are stable across
 * every ICU are pinned by name.
 *
 * Nothing below reads the clock: `sameCivilTime` formats two FIXED instants, one
 * in each hemisphere's summer, so an alias whose DST rules differed from its
 * canonical zone would still be caught and no assertion can rot with the
 * calendar.
 */
const WINTER_NORTH = "2026-01-15T02:30:00.000Z";
const SUMMER_NORTH = "2026-07-15T02:30:00.000Z";

function civilTimeAt(zone: string, instant: string): string {
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: zone,
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(instant));
}

/** True when two zone spellings put the same wall clock on the same instants. */
function sameCivilTime(left: string, right: string): boolean {
  return [WINTER_NORTH, SUMMER_NORTH].every(
    (instant) => civilTimeAt(left, instant) === civilTimeAt(right, instant),
  );
}

/**
 * The legacy POSIX-rule names, whose meaning the tz database changed under us.
 *
 * Until tzdata 2026c `EST5EDT` and `PST8PDT` were links to `America/New_York` and
 * `America/Los_Angeles`, so the runtime canonicalised them to a place and the
 * preservation rule kept it. tzdata 2026d (shipped in Node 24.22.1) made them
 * rule zones of their own again — US federal rules, no place — so the runtime
 * names them as themselves and the preservation rule refuses them exactly as it
 * refuses `Etc/GMT+5`, recording nothing. Both are the designed answer; which
 * one applies is the runtime's call, so every case below asks it first rather
 * than pinning the reading of whichever Node happens to run the suite.
 */
const LEGACY_POSIX_RULE_NAMES = ["EST5EDT", "PST8PDT"] as const;

/** What this runtime's tz database canonicalises `zone` to, or null if unknown. */
function runtimeCanonicalName(zone: string): string | null {
  try {
    return new Intl.DateTimeFormat("en-NZ", { timeZone: zone }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}

/** True when this runtime links `zone` to a place (a slash-separated location). */
function runtimeLinksToAPlace(zone: string): boolean {
  return runtimeCanonicalName(zone)?.includes("/") ?? false;
}

describe("normaliseClubTimeZoneForPreservation — keeps the zone a deployment already runs on", () => {
  it.each([
    // The stable half: these four aliases resolve to the same location on every
    // ICU this will realistically run on, so the location is pinned by name.
    ["GB", "Europe/London"],
    ["NZ", "Pacific/Auckland"],
    ["NZ-CHAT", "Pacific/Chatham"],
    ["Japan", "Asia/Tokyo"],
  ])("canonicalises %s to %s", (raw, expected) => {
    expect(normaliseClubTimeZoneForPreservation(raw)).toBe(expected);
  });

  it.each(["GB", "NZ", "NZ-CHAT", "Japan", "US/Pacific"])(
    "accepts %s, and what it returns is a real place keeping the same civil time",
    (raw) => {
      const preserved = normaliseClubTimeZoneForPreservation(raw);

      // A place — and one the rest of the app accepts as a stored value.
      expect(preserved).not.toBeNull();
      expect(isValidClubTimeZone(preserved)).toBe(true);
      // And the club is not moved: the same wall clock, in both DST seasons.
      expect(sameCivilTime(raw, preserved as string)).toBe(true);
      // Idempotent, so a second boot cannot canonicalise it again into
      // something else.
      expect(normaliseClubTimeZoneForPreservation(preserved)).toBe(preserved);
    },
  );

  it.each(LEGACY_POSIX_RULE_NAMES)(
    "keeps %s as the place this runtime links it to, or refuses it where the runtime makes it a rule zone of its own (tzdata 2026d)",
    (raw) => {
      const canonical = runtimeCanonicalName(raw);
      const preserved = normaliseClubTimeZoneForPreservation(raw);

      // Every runtime knows the name; they differ only in what it MEANS.
      expect(canonical).not.toBeNull();
      if (runtimeLinksToAPlace(raw)) {
        // tzdata <= 2026c: a link to a place, kept exactly like `GB` above.
        expect(preserved).toBe(canonical);
        expect(isValidClubTimeZone(preserved)).toBe(true);
        expect(sameCivilTime(raw, preserved as string)).toBe(true);
        expect(normaliseClubTimeZoneForPreservation(preserved)).toBe(preserved);
      } else {
        // tzdata >= 2026d: the runtime names it as itself — a rule set, not a
        // place — so there is nothing to preserve and nothing may be guessed.
        expect(canonical).toBe(raw);
        expect(preserved).toBeNull();
      }
    },
  );

  it("refuses a legacy POSIX-rule name the runtime keeps as its own zone, recording nothing", () => {
    // The tzdata >= 2026d branch above, made to run on EVERY runtime: the
    // constructor is stood in for so that `EST5EDT` resolves to itself, which
    // is exactly what Node 24.22.1 reports. A plain `function`, not an arrow,
    // because it is called with `new`; everything but that one zone is
    // delegated to the real formatter untouched.
    const RealDateTimeFormat = Intl.DateTimeFormat;
    function RuleZoneDateTimeFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ): Intl.DateTimeFormat {
      const real = new RealDateTimeFormat(locales, options);
      if (options?.timeZone !== "EST5EDT") return real;
      return {
        ...real,
        resolvedOptions: () => ({
          ...real.resolvedOptions(),
          timeZone: "EST5EDT",
        }),
      } as Intl.DateTimeFormat;
    }
    const spy = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(
        RuleZoneDateTimeFormat as unknown as typeof Intl.DateTimeFormat,
      );
    try {
      expect(runtimeCanonicalName("EST5EDT")).toBe("EST5EDT");
      expect(normaliseClubTimeZoneForPreservation("EST5EDT")).toBeNull();
      // And the environment leg falls to the documented default rather than
      // inventing a place for a rule set.
      expect(resolveClubTimeZone(null, "EST5EDT")).toBe(CLUB_TIME_ZONE_FALLBACK);
    } finally {
      spy.mockRestore();
    }
    expect(Intl.DateTimeFormat).toBe(RealDateTimeFormat);
  });

  it("returns a real IANA zone unchanged", () => {
    for (const zone of [
      "Pacific/Auckland",
      "Australia/Sydney",
      "Pacific/Chatham",
    ]) {
      expect(normaliseClubTimeZoneForPreservation(zone)).toBe(zone);
    }
  });

  it("canonicalises a case variant and trims surrounding whitespace", () => {
    expect(normaliseClubTimeZoneForPreservation("  pacific/auckland  ")).toBe(
      "Pacific/Auckland",
    );
  });

  it.each([
    // Nothing to preserve: no place on earth has any of these as its civil time,
    // so every candidate zone would be a guess — and a create-if-absent writer
    // never revisits a guess.
    "UTC",
    "GMT",
    "Zulu",
    "Universal",
    "UCT",
    "Greenwich",
    "Etc/UTC",
    "Etc/GMT-12",
    "Etc/GMT+0",
    "SystemV/EST5",
  ])("refuses %s, because it names no place", (value) => {
    expect(normaliseClubTimeZoneForPreservation(value)).toBeNull();
  });

  it.each([
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["null", null],
    ["undefined", undefined],
    ["an abbreviation no runtime knows", "NZT"],
    ["a zone this runtime does not know", "Pacific/Atlantis"],
    ["a bare fixed offset", "+12:00"],
  ])("refuses %s", (_label, value) => {
    expect(normaliseClubTimeZoneForPreservation(value)).toBeNull();
  });

  it("refuses a value longer than the column allows", () => {
    // Checked BEFORE the probe, so an absurd environment value cannot reach a
    // VarChar(64) column by way of a short canonical spelling.
    const overLong = `A/${"b".repeat(CLUB_TIME_ZONE_MAX_LENGTH)}`;
    expect(overLong.length).toBeGreaterThan(CLUB_TIME_ZONE_MAX_LENGTH);
    expect(normaliseClubTimeZoneForPreservation(overLong)).toBeNull();
  });
});

describe("the two validators differ EXACTLY as designed", () => {
  it.each(["GB", "NZ", "NZ-CHAT", "Japan"])(
    "refuses %s as operator input and preserves it as an existing deployment's zone",
    (value) => {
      // THIS ASYMMETRY IS THE FIX. The left-hand side is why an operator cannot
      // type `GB` into the admin panel: it names no place, so it promises
      // nothing about next spring's rules. The right-hand side is why a
      // deployment already running on `TZ=GB` keeps Europe/London instead of
      // being moved to New Zealand by its own upgrade.
      expect(normaliseClubTimeZone(value)).toBeNull();
      expect(normaliseClubTimeZoneForPreservation(value)).not.toBeNull();
    },
  );

  it.each(LEGACY_POSIX_RULE_NAMES)(
    "refuses %s as operator input on every runtime, and preserves it only where the runtime links it to a place",
    (value) => {
      // The left-hand side never depends on the tz database: a POSIX rule
      // string names no place whether or not this runtime links it to one.
      expect(normaliseClubTimeZone(value)).toBeNull();
      expect(normaliseClubTimeZoneForPreservation(value)).toBe(
        runtimeLinksToAPlace(value) ? runtimeCanonicalName(value) : null,
      );
    },
  );

  it("agrees on a real named zone, however it is spelled", () => {
    for (const zone of ["Pacific/Auckland", "pacific/auckland", "US/Pacific"]) {
      expect(normaliseClubTimeZoneForPreservation(zone)).toBe(
        normaliseClubTimeZone(zone),
      );
    }
  });

  it("agrees that a fixed offset or an unknown zone is refused", () => {
    for (const value of [
      "UTC",
      "Etc/GMT-12",
      "SystemV/EST5",
      "NZT",
      "Pacific/Atlantis",
      "",
      null,
      undefined,
    ]) {
      expect(normaliseClubTimeZone(value)).toBeNull();
      expect(normaliseClubTimeZoneForPreservation(value)).toBeNull();
    }
  });

  it("never preserves anything the app would then refuse to use", () => {
    // The two run at different moments — one writes the row, the other reads it
    // — so a value the preservation rule accepted and the reader rejected would
    // be written once and reported as broken for ever.
    for (const value of [
      "GB",
      "NZ",
      "NZ-CHAT",
      "EST5EDT",
      "PST8PDT",
      "Japan",
      "US/Pacific",
      "Pacific/Auckland",
      "australia/sydney",
    ]) {
      const preserved = normaliseClubTimeZoneForPreservation(value);
      if (preserved !== null) expect(isValidClubTimeZone(preserved)).toBe(true);
    }
  });
});

describe("isValidClubTimeZone", () => {
  it("agrees with normaliseClubTimeZone on every answer", () => {
    for (const value of [
      "Pacific/Auckland",
      "pacific/auckland",
      "US/Pacific",
      "NZT",
      "Etc/GMT-12",
      "",
      null,
      undefined,
    ]) {
      expect(isValidClubTimeZone(value)).toBe(
        normaliseClubTimeZone(value) !== null,
      );
    }
  });
});

describe("resolveClubTimeZone — persisted beats environment beats default", () => {
  it("uses the persisted value when it is valid, whatever the environment says", () => {
    expect(resolveClubTimeZone("Australia/Sydney", "Pacific/Auckland")).toBe(
      "Australia/Sydney",
    );
  });

  it("canonicalises the persisted value it returns", () => {
    expect(resolveClubTimeZone("australia/sydney", "Pacific/Auckland")).toBe(
      "Australia/Sydney",
    );
  });

  it("falls through to the environment seed when nothing is persisted", () => {
    expect(resolveClubTimeZone(null, "Australia/Sydney")).toBe(
      "Australia/Sydney",
    );
    expect(resolveClubTimeZone(undefined, "Australia/Sydney")).toBe(
      "Australia/Sydney",
    );
    expect(resolveClubTimeZone("", "Australia/Sydney")).toBe("Australia/Sydney");
  });

  it.each([
    ["GB", "Europe/London"],
    ["NZ-CHAT", "Pacific/Chatham"],
    ["NZ", "Pacific/Auckland"],
    ["Japan", "Asia/Tokyo"],
  ])(
    "PRESERVES the environment leg: TZ=%s resolves to %s, not the default",
    (raw, expected) => {
      /*
        THE ENVIRONMENT LEG USES THE PRESERVATION RULE, AND THIS IS THE ONLY
        THING THAT SAYS SO (#2989 fix round, finding F3).

        Every other case in this describe passes an environment value that both
        normalisers answer identically — a canonical zone, or something they both
        refuse — so all of them stay green if that leg reverts to
        `normaliseClubTimeZone`. These four (and the legacy POSIX-rule case
        below, on a runtime that still links it) are the ones that discriminate: the
        strict validator refuses each of them outright and this function would
        then return `Pacific/Auckland`, while the deployment carries on keeping
        London, Chatham or Tokyo time and the boot backfill is about to record
        exactly that. A reader that disagrees with the writer inside the
        one-boot window between `prisma migrate deploy` and the first start is
        the class this whole pair of normalisers exists to close.
      */
      expect(resolveClubTimeZone(null, raw)).toBe(expected);
      // The premise: the strict validator really does refuse these, so the
      // assertion above cannot be satisfied by both rules agreeing.
      expect(normaliseClubTimeZone(raw)).toBeNull();
      expect(normaliseClubTimeZoneForPreservation(raw)).toBe(expected);
    },
  );

  it.each(LEGACY_POSIX_RULE_NAMES)(
    "PRESERVES the environment leg for TZ=%s where this runtime links it to a place, and falls to the default where it does not",
    (raw) => {
      // The strict validator refuses the spelling on every runtime, so the
      // place can only have come through the preservation rule.
      expect(normaliseClubTimeZone(raw)).toBeNull();
      if (runtimeLinksToAPlace(raw)) {
        expect(resolveClubTimeZone(null, raw)).toBe(runtimeCanonicalName(raw));
      } else {
        // tzdata >= 2026d: a rule set is not a place; nothing is invented.
        expect(resolveClubTimeZone(null, raw)).toBe(CLUB_TIME_ZONE_FALLBACK);
      }
    },
  );

  it("keeps the persisted leg STRICT while the environment leg preserves", () => {
    // The two legs must not converge on one rule in either direction. A stored
    // `GB` came through the operator-input validator when it was written, so one
    // that fails now is corrupt and the reader falls through — to the
    // environment, which for the same spelling is preserved.
    expect(resolveClubTimeZone("GB", "Australia/Sydney")).toBe(
      "Australia/Sydney",
    );
    expect(resolveClubTimeZone("GB", "GB")).toBe("Europe/London");
    expect(resolveClubTimeZone("GB", null)).toBe(CLUB_TIME_ZONE_FALLBACK);
  });

  it("falls through to the environment seed when the persisted value is unusable", () => {
    // The only ways to get an invalid persisted value are database surgery and
    // an ICU that no longer knows the zone. Treating it as absent keeps the app
    // answering instead of throwing on every request.
    for (const broken of ["NZT", "+12:00", "Etc/GMT-12", "Pacific/Atlantis"]) {
      expect(resolveClubTimeZone(broken, "Australia/Sydney")).toBe(
        "Australia/Sydney",
      );
    }
  });

  it("falls back to the documented default when neither is usable", () => {
    expect(resolveClubTimeZone(null, null)).toBe(CLUB_TIME_ZONE_FALLBACK);
    expect(resolveClubTimeZone(null, "NZT")).toBe(CLUB_TIME_ZONE_FALLBACK);
    expect(resolveClubTimeZone("NZT", "+12:00")).toBe(CLUB_TIME_ZONE_FALLBACK);
    expect(CLUB_TIME_ZONE_FALLBACK).toBe("Pacific/Auckland");
  });

  it("never returns an invalid zone, whatever it is handed", () => {
    for (const persisted of [null, "", "NZT", "Pacific/Auckland", "US/Pacific"]) {
      for (const env of [null, "", "Etc/GMT-12", "Australia/Sydney"]) {
        expect(isValidClubTimeZone(resolveClubTimeZone(persisted, env))).toBe(
          true,
        );
      }
    }
  });
});

describe("listSelectableClubTimeZones", () => {
  it("offers only zones the validator accepts, including the documented default", () => {
    const offered = listSelectableClubTimeZones();
    expect(offered).toContain(CLUB_TIME_ZONE_FALLBACK);
    expect(offered.filter((zone) => !isValidClubTimeZone(zone))).toEqual([]);
  });

  it("offers each zone once, in a stable order", () => {
    const offered = listSelectableClubTimeZones();
    expect(new Set(offered).size).toBe(offered.length);
    expect(offered).toEqual([...offered].sort((a, b) => a.localeCompare(b, "en")));
  });
});
