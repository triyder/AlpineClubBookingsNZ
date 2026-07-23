import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildKioskTokens,
  KIOSK_TOKEN_ORDER,
} from "@/lib/theme/kiosk-tokens";

// #2189 P3 (epic #2181 A5/J4) — the fixed-seed kiosk token contract.
//
// The kiosk / wall-display surfaces are the deliberately literalist, glare-proof,
// NON-brand-following exception. They are authored ONCE from the fixed kiosk seed
// (PINS.kiosk) and render identically on every club AND in either light/dark mode.
// `globals.css` therefore carries the token set as LITERAL values (a standalone,
// mode-agnostic `:root` block + the `@theme` `--color-kiosk-*` utilities). This
// test pins every literal against `buildKioskTokens()` — P1's fallback-pin pattern
// (R9) — so the CSS and the derivation can never silently drift.

function readGlobals(): string {
  return readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
}

describe("fixed-seed kiosk token contract (#2189 P3)", () => {
  const globals = readGlobals();
  const tokens = buildKioskTokens();

  it("derives a value for every ordered token, and vice versa", () => {
    expect(Object.keys(tokens).sort()).toEqual([...KIOSK_TOKEN_ORDER].sort());
    for (const name of KIOSK_TOKEN_ORDER) {
      expect(tokens[name], `--kiosk-${name}`).toMatch(/^#[0-9a-f]{3,8}$/);
    }
  });

  it("pins the standalone `:root` --kiosk-* declarations against the derivation", () => {
    for (const name of KIOSK_TOKEN_ORDER) {
      expect(
        globals,
        `globals.css must declare --kiosk-${name} with its derived fixed value`,
      ).toContain(`--kiosk-${name}: ${tokens[name]};`);
    }
  });

  it("pins the @theme --color-kiosk-* fallbacks against the derivation (R9)", () => {
    for (const name of KIOSK_TOKEN_ORDER) {
      expect(
        globals,
        `@theme must surface bg/text/border-kiosk-${name} with its derived fallback`,
      ).toContain(
        `--color-kiosk-${name}: var(--kiosk-${name}, ${tokens[name]});`,
      );
    }
  });

  it("keeps the page background on the A5 fixed near-black seed, club-independent", () => {
    // The whole point of A5: the kiosk NEVER follows the club accent. The page is
    // the pinned fixed near-black seed, and the action accent is the fixed #7dd3fc
    // kiosk accent, not a brand colour.
    expect(tokens.page).toBe("#0a0a0b");
    expect(tokens.accent).toBe("#7dd3fc");
  });

  it("is mode-invariant: the old #1249 light-mode kiosk remap is gone", () => {
    // The kiosk tokens are declared once, un-gated, so the kiosk renders the same
    // whether or not the document carries the dark class. The literal-keyed
    // light-mode readability override (`theme-aware-kiosk` remapped under
    // `html:not(.dark)`) no longer exists — grep-proof, R3/F2.
    expect(globals).not.toContain("theme-aware-kiosk");
    expect(globals).not.toContain("html:not(.dark)");
  });
});
