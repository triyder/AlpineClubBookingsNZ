import { describe, expect, it } from "vitest";
import {
  listDisplayModules,
  type DisplayModuleOptionDescriptor,
} from "@/lib/lodge-display/module-registry";
import { DISPLAY_MODULE_NAMES } from "@/lib/lodge-display/template-registry";
import {
  ARRIVALS_BOARD_DEFAULT_DAYS,
  ARRIVALS_BOARD_MAX_NAMES,
  ARRIVALS_BOARD_NAME_STYLES,
  NIGHT_COLUMNS_DEFAULT_DAYS,
  NIGHT_COLUMNS_MAX_DAYS,
  OCCUPANCY_GRID_VARIANTS,
  boolOption,
  enumOption,
  intOption,
} from "@/components/lodge-display/modules/module-options";

// Descriptor drift guard + privacy floor (ADR-004 §3/§5, §9). The builder's
// settings drawer is generated PURELY from each module's `options` descriptors;
// these tests bind every descriptor to (a) the module's real parser
// (`intOption`/`boolOption`/`enumOption`) so the drawer can never present a value
// the renderer would reject or silently default, (b) the source constants, and
// (c) the privacy floor — no descriptor may widen a name field.

// The EXPECTED descriptor keys per module. A new module that gains real options
// in its component but no descriptor here (or vice versa) fails this sweep — the
// forcing function the ADR's "a new module without a descriptor fails" calls for.
const EXPECTED_OPTION_KEYS: Record<string, string[]> = {
  "lodge-header": [],
  "arrivals-board": ["days", "max-names", "name-style"],
  "occupancy-grid": ["days", "max-names", "variant"],
  welcome: [],
  "singles-board": ["days"],
  "room-cards": [],
  "night-columns": ["days", "show-rooms"],
  "status-board": [],
  "chores-board": [],
  "lodge-rules": [],
  "notice-board": [],
  "info-footer": [],
};

const modules = listDisplayModules();

describe("module option descriptors — coverage sweep", () => {
  it("every registered module has a descriptor array", () => {
    for (const name of DISPLAY_MODULE_NAMES) {
      const meta = modules.find((m) => m.name === name);
      expect(meta, `missing metadata for ${name}`).toBeDefined();
      expect(Array.isArray(meta!.options)).toBe(true);
    }
  });

  it("descriptor keys match the expected set exactly (drift guard)", () => {
    const actual: Record<string, string[]> = {};
    for (const meta of modules) actual[meta.name] = meta.options.map((o) => o.key);
    expect(actual).toEqual(EXPECTED_OPTION_KEYS);
  });

  it("no module declares a duplicate option key", () => {
    for (const meta of modules) {
      const keys = meta.options.map((o) => o.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

/** Assert one descriptor is consistent with what the real parser would accept. */
function assertBoundToParser(d: DisplayModuleOptionDescriptor) {
  if (d.type === "int") {
    expect(intOption(undefined, d.key, d.default, { min: d.min, max: d.max })).toBe(d.default);
    expect(intOption({ [d.key]: d.max + 1000 }, d.key, d.default, { min: d.min, max: d.max })).toBe(d.max);
    expect(intOption({ [d.key]: d.min - 1000 }, d.key, d.default, { min: d.min, max: d.max })).toBe(d.min);
    expect(intOption({ [d.key]: "not-a-number" }, d.key, d.default, { min: d.min, max: d.max })).toBe(d.default);
    expect(d.default).toBeGreaterThanOrEqual(d.min);
    expect(d.default).toBeLessThanOrEqual(d.max);
  } else if (d.type === "bool") {
    expect(boolOption(undefined, d.key, d.default)).toBe(d.default);
    expect(boolOption({ [d.key]: !d.default }, d.key, d.default)).toBe(!d.default);
  } else {
    expect(enumOption(undefined, d.key, d.default, d.allowed)).toBe(d.default);
    expect(d.allowed).toContain(d.default);
    for (const value of d.allowed) {
      expect(enumOption({ [d.key]: value }, d.key, d.default, d.allowed)).toBe(value);
    }
    expect(enumOption({ [d.key]: "__not-in-set__" }, d.key, d.default, d.allowed)).toBe(d.default);
  }
}

describe("module option descriptors — parser binding (drift guard)", () => {
  for (const meta of modules) {
    for (const descriptor of meta.options) {
      it(`${meta.name}.${descriptor.key} matches its parser`, () => {
        assertBoundToParser(descriptor);
      });
    }
  }

  it("descriptor defaults/allowed sets equal the source constants", () => {
    const arrivals = modules.find((m) => m.name === "arrivals-board")!;
    const days = arrivals.options.find((o) => o.key === "days")!;
    const maxNames = arrivals.options.find((o) => o.key === "max-names")!;
    const nameStyle = arrivals.options.find((o) => o.key === "name-style")!;
    expect(days.type === "int" && days.default).toBe(ARRIVALS_BOARD_DEFAULT_DAYS);
    expect(maxNames.type === "int" && maxNames.default).toBe(ARRIVALS_BOARD_MAX_NAMES);
    expect(nameStyle.type === "enum" && nameStyle.allowed).toEqual(ARRIVALS_BOARD_NAME_STYLES);

    const occupancy = modules.find((m) => m.name === "occupancy-grid")!;
    const variant = occupancy.options.find((o) => o.key === "variant")!;
    expect(variant.type === "enum" && variant.allowed).toEqual(OCCUPANCY_GRID_VARIANTS);

    const night = modules.find((m) => m.name === "night-columns")!;
    const nightDays = night.options.find((o) => o.key === "days")!;
    expect(nightDays.type === "int" && nightDays.default).toBe(NIGHT_COLUMNS_DEFAULT_DAYS);
    expect(nightDays.type === "int" && nightDays.max).toBe(NIGHT_COLUMNS_MAX_DAYS);
  });
});

describe("module option descriptors — privacy floor (ADR-004 §5)", () => {
  // The closed allowlist of non-widening option keys. Every descriptor key MUST
  // be one of these — a new key must be reviewed and added deliberately, so a
  // widening control (e.g. `show-full-names`, `name-granularity`, `reveal-phone`)
  // can never slip into the drawer unnoticed.
  //
  // PRIVACY REVIEW GATE: editing this allowlist IS the privacy review. Adding a
  // key here (to make a new module option pass this sweep) must be justified in
  // the PR that adds it as non-widening — i.e. it can only reduce or leave name /
  // guest-detail exposure unchanged, never raise it. Do not add a key to make a
  // test go green without that justification recorded in the PR.
  const ALLOWED_KEYS = new Set(["days", "max-names", "name-style", "variant", "show-rooms"]);

  // Patterns that would smell like a name/privacy WIDENING control.
  const WIDENING_PATTERN = /(granularity|full[-_]?name|reveal|unmask|minor|phone|surname|last[-_]?name)/i;

  it("every descriptor key is on the non-widening allowlist", () => {
    for (const meta of modules) {
      for (const d of meta.options) {
        expect(ALLOWED_KEYS.has(d.key), `${meta.name}.${d.key} not on the privacy allowlist`).toBe(true);
      }
    }
  });

  it("no descriptor key or label matches a widening pattern", () => {
    for (const meta of modules) {
      for (const d of meta.options) {
        expect(WIDENING_PATTERN.test(d.key)).toBe(false);
        expect(WIDENING_PATTERN.test(d.label)).toBe(false);
      }
    }
  });

  it("the only name-affecting enum stays within the reduce-or-equal set", () => {
    // name-style may only reduce (lead-count) or leave names as the already
    // privacy-reduced payload provides — it can never raise granularity.
    const nameStyle = modules
      .find((m) => m.name === "arrivals-board")!
      .options.find((o) => o.key === "name-style")!;
    expect(nameStyle.type === "enum" && [...nameStyle.allowed].sort()).toEqual(
      ["lead-count", "names"]
    );
  });
});
