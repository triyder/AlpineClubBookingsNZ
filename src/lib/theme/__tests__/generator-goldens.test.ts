import { describe, expect, it } from "vitest";
import {
  buildThemeSubstrate,
  buildKioskTheme,
  a2ComputedPick,
  a4SolidForeground,
  HUE_SCALES,
} from "../theme-substrate";
import { SEED_SETS } from "./reference-seed-sets";
import goldens from "./theme-goldens.json";

/*
 * Golden-value tests (#2187 P1, acceptance criteria 1–2).
 *
 * theme-goldens.json is generated INSIDE node:24.17-alpine (the production image)
 * by scripts/theme/generate-goldens.ts — see that file's header for the exact
 * docker-run command. These tests pin every substrate hex for both migrated seed
 * sets × both modes + the fixed kiosk, so a ±1/255 float wiggle from a dependency
 * bump or a Node change is a failing test, not a silent ship. CI runs on Node 24.
 *
 * The committed golden was verified identical between Node 22.14.0 and Node 24.17.0
 * at authoring time (0 value diffs), so the suite also passes on the local Node 22
 * dev toolchain.
 */

type ModeGolden = {
  scales: Record<string, string[]>;
  neutralAlpha: string[];
  a2Computed: { step: number; idx: number; hex: string; min: number } | null;
  a4SolidFg: Record<string, { step9: string; step10: string }>;
};

const themes = goldens.themes as Record<string, Record<string, ModeGolden>>;

describe("theme substrate golden values", () => {
  for (const seedName of Object.keys(SEED_SETS) as Array<keyof typeof SEED_SETS>) {
    for (const mode of ["light", "dark"] as const) {
      const golden = themes[seedName][mode];
      it(`${seedName}/${mode} reproduces the pinned substrate exactly`, () => {
        const built = buildThemeSubstrate(SEED_SETS[seedName], mode);
        for (const [name, hex] of Object.entries(golden.scales)) {
          expect(built.scales[name].hex, `${seedName}/${mode}/${name}`).toEqual(hex);
        }
        expect(built.neutralAlpha).toEqual(golden.neutralAlpha);
      });
    }
  }

  it("kiosk/dark reproduces the pinned A5 substrate exactly", () => {
    const { theme } = buildKioskTheme();
    for (const [name, hex] of Object.entries(themes.kiosk.dark.scales)) {
      expect(theme.scales[name].hex, `kiosk/dark/${name}`).toEqual(hex);
    }
  });

  it("A2 computed pick and A4 solid-foreground match the goldens", () => {
    for (const seedName of Object.keys(SEED_SETS) as Array<keyof typeof SEED_SETS>) {
      const light = buildThemeSubstrate(SEED_SETS[seedName], "light");
      const lightN12 = light.neutralHex[11];
      for (const mode of ["light", "dark"] as const) {
        const t = mode === "light" ? light : buildThemeSubstrate(SEED_SETS[seedName], mode);
        expect(a2ComputedPick(t.neutralHex)).toEqual(themes[seedName][mode].a2Computed);
        for (const name of HUE_SCALES) {
          const s = t.scales[name];
          const g = themes[seedName][mode].a4SolidFg[name];
          expect(a4SolidForeground(s.hex[8], s.generatorContrast as string, lightN12).pick).toBe(g.step9);
          expect(a4SolidForeground(s.hex[9], s.generatorContrast as string, lightN12).pick).toBe(g.step10);
        }
      }
    }
  });

  it("is deterministic: two consecutive builds are byte-identical (verified twice)", () => {
    for (const seedName of Object.keys(SEED_SETS) as Array<keyof typeof SEED_SETS>) {
      for (const mode of ["light", "dark"] as const) {
        const a = buildThemeSubstrate(SEED_SETS[seedName], mode);
        const b = buildThemeSubstrate(SEED_SETS[seedName], mode);
        expect(JSON.stringify(a.scales)).toBe(JSON.stringify(b.scales));
      }
    }
  });
});
