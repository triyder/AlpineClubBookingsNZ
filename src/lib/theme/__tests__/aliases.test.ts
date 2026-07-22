import { describe, expect, it } from "vitest";
import {
  CORE_ALIASES,
  SIDEBAR_ALIASES,
  DESTRUCTIVE_DANGER_ALIASES,
  CHART_ALIASES,
  CHART_FINANCE_8SLOT,
  resolveAlias,
  A2_INPUT_RING_NEUTRAL_STEP,
} from "../aliases";
import { buildThemeSubstrate } from "../theme-substrate";
import { SEED_SETS } from "./reference-seed-sets";
import aliasesJson from "../../../../docs/theme/phase0/data/aliases.json";

/*
 * Alias map is DATA (#2187 P1). These pin that the encoded table matches
 * aliases.json and the acceptance-criteria structural facts, and that the R9
 * computed entries resolve by RULE (J1 neutral-10 for A2), not by copied literal.
 */

describe("token alias map (data)", () => {
  it("matches aliases.json for the step-ref core entries", () => {
    const core = aliasesJson.core as Record<string, any>;
    for (const [token, entry] of Object.entries(CORE_ALIASES)) {
      if ("scale" in entry && "from" in aliasesJson) {
        const j = core[token];
        if (j.scale) {
          expect((entry as any).scale, token).toBe(j.scale);
          expect((entry as any).step, token).toBe(j.step);
        }
      }
    }
  });

  it("--accent = neutral-4 is one band off --muted/--secondary = neutral-3 (the #2144 hover fix)", () => {
    expect(CORE_ALIASES["--accent"]).toMatchObject({ scale: "neutral", step: 4 });
    expect(CORE_ALIASES["--muted"]).toMatchObject({ scale: "neutral", step: 3 });
    expect(CORE_ALIASES["--secondary"]).toMatchObject({ scale: "neutral", step: 3 });
  });

  it("sidebar surfaces come from neutral steps 1–4 (D13)", () => {
    expect(SIDEBAR_ALIASES["--sidebar"]).toMatchObject({ scale: "neutral", step: 1 });
    expect(SIDEBAR_ALIASES["--sidebar-accent"]).toMatchObject({ scale: "neutral", step: 3 });
    expect(SIDEBAR_ALIASES["--sidebar-border"]).toMatchObject({ scale: "neutral", step: 4 });
  });

  it("--destructive ≡ --danger (D14 one red), --destructive-foreground recomputed (A4)", () => {
    expect(DESTRUCTIVE_DANGER_ALIASES["--destructive"]).toMatchObject({ scale: "danger" });
    expect(DESTRUCTIVE_DANGER_ALIASES["--danger"]).toMatchObject({ scale: "danger" });
    expect(DESTRUCTIVE_DANGER_ALIASES["--destructive-foreground"]).toMatchObject({ from: "A4", scale: "danger" });
  });

  it("chart map = cat1–5 step 9; finance 8-slot = cat1–5 step 9 + cat1–3 step 7 (D15/J7)", () => {
    expect(CHART_ALIASES).toEqual([1, 2, 3, 4, 5].map((i) => ({ token: `--chart-${i}`, scale: `cat${i}`, step: 9 })));
    expect(CHART_FINANCE_8SLOT.slice(0, 5).every((c) => c.step === 9)).toBe(true);
    expect(CHART_FINANCE_8SLOT.slice(5).map((c) => `${c.scale}:${c.step}`)).toEqual(["cat1:7", "cat2:7", "cat3:7"]);
  });

  it("R9/J1: --input and --ring resolve to neutral-10 UNIFORMLY, both seeds/modes", () => {
    expect(A2_INPUT_RING_NEUTRAL_STEP).toBe(10);
    for (const seedName of Object.keys(SEED_SETS) as Array<keyof typeof SEED_SETS>) {
      for (const mode of ["light", "dark"] as const) {
        const t = buildThemeSubstrate(SEED_SETS[seedName], mode);
        const n10 = t.neutralHex[9];
        expect(resolveAlias(CORE_ALIASES["--input"], t, t.neutralHex[11])).toBe(n10);
        expect(resolveAlias(CORE_ALIASES["--ring"], t, t.neutralHex[11])).toBe(n10);
      }
    }
  });
});
