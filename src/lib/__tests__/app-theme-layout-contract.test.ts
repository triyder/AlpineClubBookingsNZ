import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS,
  APP_MUTED_FOREGROUND_EXCLUDED_SURFACES,
  APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS,
  DEFAULT_CLUB_THEME_VALUES,
  contrastRatio,
  deriveAppMutedForeground,
} from "@/lib/club-theme-schema";

function readRepoFile(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

function listSourceFiles(path: string): string[] {
  return readdirSync(join(process.cwd(), path)).flatMap((entry) => {
    const child = join(path, entry);
    return statSync(join(process.cwd(), child)).isDirectory()
      ? listSourceFiles(child)
      : /\.(?:css|tsx?)$/.test(entry)
        ? [child]
        : [];
  });
}

/** Every quoted string literal in a source file, unescaped body only. */
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * The source text of every `cn(…)` call, paren-balanced.
 *
 * A naive depth count, so a literal paren inside a string can over-extend a
 * region. That errs toward a LARGER context, i.e. toward a false positive that
 * a human then triages — never toward silently missing a pairing.
 */
function cnCallRegions(source: string): string[] {
  const regions: string[] = [];

  for (const match of source.matchAll(/\bcn\(/g)) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let index = start;
    for (; index < source.length; index += 1) {
      if (source[index] === "(") {
        depth += 1;
      } else if (source[index] === ")") {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    regions.push(source.slice(start, index + 1));
  }

  return regions;
}

/**
 * Every CLASS-STRING CONTEXT in a source file: each string literal on its own,
 * plus the concatenation of all literals inside each `cn(…)` call.
 *
 * Anchoring on `className=` — the obvious approach — misses the house idiom
 * `cn("…", cond && "…")` entirely, including the case where both classes sit in
 * a single literal that happens to be a `cn()` argument. Scanning literals and
 * `cn()` argument lists instead sees both shapes. Pinned by the probe test
 * beside the neutral-200 scan that uses it.
 */
function classStringContexts(source: string): string[] {
  const literals = (text: string) =>
    [...text.matchAll(STRING_LITERAL)].map((match) => match[2]);

  return [
    ...literals(source),
    ...cnCallRegions(source).map((region) => literals(region).join(" ")),
  ];
}

describe("database theme app-shell contract", () => {
  it.each([
    ["src/app/(public)/layout.tsx", "getCachedWebsiteThemeRenderState()"],
    ["src/app/(authenticated)/layout.tsx", "getWebsiteThemeRenderState()"],
    ["src/app/(admin)/layout.tsx", "getWebsiteThemeRenderState()"],
    ["src/app/(finance)/finance/layout.tsx", "getWebsiteThemeRenderState()"],
    ["src/app/(lodge)/layout.tsx", "getWebsiteThemeRenderState()"],
  ])(
    "injects the sanitized ClubTheme CSS in %s",
    (path, themeLoader) => {
      const layout = readRepoFile(path);

      expect(layout).toContain(themeLoader);
      expect(layout).toContain('data-site-style="club-theme"');
      expect(layout).toContain(
        "dangerouslySetInnerHTML={{ __html: theme.appCss }}",
      );
    },
  );

  it("loads configured font variables in the public utility layout", () => {
    const layout = readRepoFile("src/app/(public)/layout.tsx");

    expect(layout).toContain("clubThemeFontVariableClassName");
    expect(layout).not.toContain('from "next/font/google"');
  });

  it.each([
    "src/app/(authenticated)/layout.tsx",
    "src/app/(admin)/layout.tsx",
    "src/app/(finance)/finance/layout.tsx",
    "src/app/(lodge)/layout.tsx",
  ])("applies the configured font-variable class to the app shell in %s", (path) => {
    const layout = readRepoFile(path);

    expect(layout).toContain("clubThemeFontVariableClassName");
  });

  it("passes the configured public logo to public utility shell chrome", () => {
    const layout = readRepoFile("src/app/(public)/layout.tsx");

    expect(layout).toMatch(
      /<WebsiteHeader[\s\S]*?logoDataUrl=\{theme\.logoDataUrl\}[\s\S]*?\/>/,
    );
    expect(layout).toMatch(
      /<WebsiteFooter[\s\S]*?logoDataUrl=\{theme\.logoDataUrl\}[\s\S]*?\/>/,
    );
  });

  it.each(["src/app/(authenticated)/layout.tsx", "src/app/(admin)/layout.tsx"])(
    "moves keyboard focus to the skip-link target in %s",
    (path) => {
      const layout = readRepoFile(path);

      expect(layout).toContain('href="#main-content"');
      expect(layout).toMatch(/<main\s+[\s\S]*?id="main-content"[\s\S]*?tabIndex=\{-1\}/);
    },
  );

  it("keeps the shared error Alert on the AA danger pair", () => {
    const alert = readRepoFile("src/components/ui/alert.tsx");

    expect(alert).toContain(
      'error: "border-danger/20 bg-danger-muted text-danger"',
    );
    expect(alert).not.toMatch(/error:.*destructive/);
  });

  it("maps app presentation tokens to brand variables without remapping semantic status", () => {
    const globals = readRepoFile("src/app/globals.css");
    const start = globals.indexOf(".app-theme-scope {");
    const end = globals.indexOf("/* App headings pick up", start);
    const appThemeRules = globals.slice(start, end);
    const darkStart = appThemeRules.indexOf(".dark .app-theme-scope {");
    const lightRules = appThemeRules.slice(0, darkStart);
    const darkRules = appThemeRules.slice(darkStart);

    expect(appThemeRules).toContain("--primary: var(--brand-gold)");
    for (const token of ["background", "card", "popover"]) {
      expect(lightRules).toContain(`--${token}: var(--brand-snow)`);
    }
    for (const token of ["secondary", "muted", "accent"]) {
      expect(lightRules).toContain(`--${token}: var(--brand-mist)`);
    }
    for (const token of [
      "foreground",
      "card-foreground",
      "popover-foreground",
      "secondary-foreground",
      "accent-foreground",
    ]) {
      expect(lightRules).toContain(`--${token}: var(--brand-deep)`);
    }
    // `--muted-foreground` is deliberately NOT in that list (#2145): it is a
    // semantic role, so it must resolve to a DERIVED tone rather than alias
    // `--foreground`/`--brand-deep`.
    expect(lightRules).toContain(
      "--muted-foreground: var(--app-muted-foreground,",
    );
    expect(lightRules).not.toContain("--muted-foreground: var(--brand-deep)");
    expect(lightRules).toContain("--sidebar: var(--brand-charcoal)");
    expect(lightRules).toContain("--sidebar-accent: var(--brand-deep)");
    expect(lightRules).toContain("--sidebar-foreground: var(--brand-snow)");
    expect(lightRules).toContain("--sidebar-accent-foreground: var(--brand-snow)");
    expect(lightRules).toContain("--ring: var(--brand-deep)");
    expect(lightRules).toContain("--sidebar-ring: var(--brand-snow)");
    expect(darkRules).toContain("--background: var(--brand-deep)");
    for (const token of [
      "card",
      "popover",
      "secondary",
      "muted",
      "accent",
      "sidebar",
    ]) {
      expect(darkRules).toContain(`--${token}: var(--brand-charcoal)`);
    }
    for (const token of [
      "foreground",
      "card-foreground",
      "popover-foreground",
      "secondary-foreground",
      "accent-foreground",
      "sidebar-foreground",
      "sidebar-accent-foreground",
    ]) {
      expect(darkRules).toContain(`--${token}: var(--brand-snow)`);
    }
    expect(darkRules).toContain(
      "--muted-foreground: var(--app-muted-foreground-dark,",
    );
    expect(darkRules).not.toContain("--muted-foreground: var(--brand-snow)");
    expect(darkRules).toContain("--sidebar-accent: var(--brand-deep)");
    expect(darkRules).toContain("--ring: var(--brand-snow)");
    expect(darkRules).toContain("--sidebar-ring: var(--brand-snow)");
    expect(lightRules).toContain("--app-accent-text: var(--brand-deep)");
    expect(darkRules).toContain("--app-accent-text: var(--brand-snow)");
    expect(appThemeRules).not.toMatch(
      /--(?:background|foreground|card|card-foreground|popover|popover-foreground|secondary|secondary-foreground|muted|muted-foreground|accent|accent-foreground|sidebar|sidebar-foreground|sidebar-accent|sidebar-accent-foreground):\s*color-mix/,
    );
    expect(appThemeRules).toContain('[class~="hover:text-primary"]:hover');
    expect(appThemeRules).toContain(
      '.group:hover [class~="group-hover:text-primary"]',
    );
    expect(appThemeRules.match(/:not\(\.website-theme \*\)/g)).toHaveLength(4);
    expect(appThemeRules).toContain(":focus-visible:not(.website-theme *)");
    expect(appThemeRules).toContain("outline: 2px solid var(--ring) !important");
    expect(appThemeRules).toContain("outline-offset: 2px !important");
    expect(appThemeRules).toContain("--font-website-body");
    expect(appThemeRules).toContain("--font-website-heading");
    expect(appThemeRules).not.toMatch(
      /--(?:success|warning|info|danger)(?:-|:)/,
    );
  });

  // #2145 — the CSS half of the derived muted role. The value itself is derived
  // and gated in `club-theme-schema.test.ts`; this pins the wiring in
  // `globals.css` that makes the derived value reach the token, and the static
  // fallback that stands in when no ClubTheme stylesheet has been injected.
  it("wires the derived app muted role to the injected tokens", () => {
    const globals = readRepoFile("src/app/globals.css");
    const start = globals.indexOf(".app-theme-scope {");
    const end = globals.indexOf("/* App headings pick up", start);
    const appThemeRules = globals.slice(start, end);
    const darkStart = appThemeRules.indexOf(".dark .app-theme-scope {");
    const lightRules = appThemeRules.slice(0, darkStart);
    const darkRules = appThemeRules.slice(darkStart);
    const fallback = deriveAppMutedForeground(DEFAULT_CLUB_THEME_VALUES);

    // The literal fallbacks are the derivation of the shipped default palette.
    // Hardcoding them in CSS is unavoidable (the static sheet cannot run the
    // derivation), so this is the pin that stops the two drifting apart.
    expect(lightRules).toContain(
      `--muted-foreground: var(--app-muted-foreground, ${fallback.light});`,
    );
    expect(darkRules).toContain(
      `--muted-foreground: var(--app-muted-foreground-dark, ${fallback.dark});`,
    );

    // The fallback must be a solid colour, not a color-mix: a mix is
    // unmeasurable from the contrast gate, which is the same reason every other
    // app text token in this block stays a solid brand endpoint.
    expect(fallback.light).toMatch(/^#[0-9a-f]{6}$/);
    expect(fallback.dark).toMatch(/^#[0-9a-f]{6}$/);

    // #2146 print pairing: BOTH blocks must declare `--muted-foreground`, so
    // excluding the dark block from print media leaves the light derived tone
    // standing on paper. `print-light-palette-contract.test.ts` derives its
    // healed-token set from exactly this pairing.
    expect(lightRules).toContain("--muted-foreground:");
    expect(darkRules).toContain("--muted-foreground:");
  });

  // The fallback above is only ever used when NO ClubTheme sheet is injected —
  // and in that case the surrounding surfaces come from the `:root`/`.dark`
  // literals, not from `DEFAULT_CLUB_THEME_VALUES`. Deriving the fallback from
  // the default palette is therefore only correct because those two agree.
  // Nothing asserted that until now, so a `:root` retune would have left the
  // un-themed app pairing a tone derived from one palette against surfaces from
  // another, with every existing test still green.
  it("keeps the un-themed :root surfaces byte-identical to the default palette", () => {
    const globals = readRepoFile("src/app/globals.css");
    const rootRules = globals.slice(
      globals.indexOf(":root {"),
      globals.indexOf("@media not print {"),
    );

    expect(rootRules).toContain(":root {");

    for (const [variable, value] of [
      ["--brand-gold", DEFAULT_CLUB_THEME_VALUES.brandGold],
      ["--brand-charcoal", DEFAULT_CLUB_THEME_VALUES.brandCharcoal],
      ["--brand-deep", DEFAULT_CLUB_THEME_VALUES.brandDeep],
      ["--brand-ridge", DEFAULT_CLUB_THEME_VALUES.brandRidge],
      ["--brand-mist", DEFAULT_CLUB_THEME_VALUES.brandMist],
      ["--brand-snow", DEFAULT_CLUB_THEME_VALUES.brandSnow],
      ["--brand-safety", DEFAULT_CLUB_THEME_VALUES.brandSafety],
    ] as const) {
      expect(rootRules).toContain(`${variable}: ${value};`);
    }
  });

  // #2145 — the clamp checks the curated semantic `*-muted` panel fills, which
  // #1808 deliberately leaves OUT of `app-theme-scope`. That means the values
  // live in `globals.css` and are copied into `club-theme-schema.ts`, so this
  // is the pin that stops a retune of one silently invalidating the other.
  it("keeps the semantic muted surfaces the clamp checks in step with globals.css", () => {
    const globals = readRepoFile("src/app/globals.css");
    const schema = readRepoFile("src/lib/club-theme-schema.ts");
    const darkStart = globals.indexOf("@media not print {");
    const rootRules = globals.slice(globals.indexOf(":root {"), darkStart);
    const darkRules = globals.slice(
      darkStart,
      globals.indexOf(".website-theme {", darkStart),
    );

    expect(darkStart).toBeGreaterThan(0);

    for (const token of ["warning", "info", "success", "danger"] as const) {
      const light = new RegExp(`--${token}-muted:\\s*(#[0-9a-f]{6});`).exec(
        rootRules,
      );
      const dark = new RegExp(`--${token}-muted:\\s*(oklch\\([^)]*\\));`).exec(
        darkRules,
      );

      expect(light, `light --${token}-muted in globals.css`).not.toBeNull();
      expect(dark, `dark --${token}-muted in globals.css`).not.toBeNull();
      expect(schema).toContain(`"${light![1]}", // --${token}-muted`);
      expect(schema).toContain(`"${dark![1]}", // --${token}-muted`);
    }
  });

  // #2145 — `--border` is deliberately NOT in the clamp set, on the grounds
  // that a hairline colour is not a text background. Dark mode remaps
  // `bg-{neutral}-200` onto `--border`, so that reasoning only holds while no
  // `bg-{neutral}-200` element carries de-emphasised text. It did: a
  // `bg-slate-200 text-slate-500` badge in `page-content-panel.tsx` resolved to
  // muted-on-border at 3.74:1 (default) and 3.54:1 (Tokoroa) in dark mode. It
  // now uses `bg-muted text-muted-foreground`. This keeps the exclusion honest.
  //
  // The scan deliberately does NOT anchor on `className=`. The house idiom is
  // `cn("…", cond && "…")`, so an anchored scan skips exactly the files this
  // issue had to fix (`allocation-chip.tsx`, `bucket-board.tsx`) and would not
  // have caught the original `page-content-panel.tsx` offender had it been
  // written the house way. Instead every quoted string literal is a context in
  // its own right, and every `cn(…)` argument list is a context too — so a pair
  // split across two arguments of one `cn()` call is still seen as one class
  // set.
  it("keeps de-emphasised text off the neutral-200 surfaces that remap to --border", () => {
    const hasBorderSurface = (classes: string) =>
      /(?:^|\s)bg-(?:slate|gray|zinc|neutral|stone)-200(?:\s|$)/.test(classes);
    const hasMutedText = (classes: string) =>
      /(?:^|\s)text-(?:muted-foreground|(?:slate|gray|zinc|neutral|stone)-(?:300|400|500|600|700))(?:\s|$)/.test(
        classes,
      );

    const offenders = listSourceFiles("src")
      // `.ts` as well as `.tsx`: class strings live in plain modules too
      // (`chip-tones.ts` is a whole file of them). Test files are excluded —
      // they render nothing, and the probe test below deliberately contains
      // offending strings.
      .filter((path) => /\.tsx?$/.test(path) && !path.includes("__tests__"))
      .flatMap((path) =>
        classStringContexts(readRepoFile(path))
          .filter(
            (classes) => hasBorderSurface(classes) && hasMutedText(classes),
          )
          .map((classes) => `${path}: ${classes}`),
      );

    expect(offenders).toEqual([]);
  });

  // The widened scan above is only worth anything if it actually sees the house
  // idiom, so its reach is pinned directly rather than assumed. The three probes
  // are the shapes the previous `className=`-anchored regex missed: the second
  // and third both come straight from files this PR touches.
  it("sees neutral-200 pairings through cn(), not just className=", () => {
    const probes = [
      '<span className="bg-slate-200 px-1 text-slate-500" />',
      '<span className={cn("rounded bg-slate-200 px-1", "text-slate-500")} />',
      '<span className={cn("rounded bg-slate-200 px-1 text-slate-500", x && "z")} />',
    ];

    for (const probe of probes) {
      const contexts = classStringContexts(probe);
      expect(
        contexts.some(
          (classes) =>
            /(?:^|\s)bg-slate-200(?:\s|$)/.test(classes) &&
            /(?:^|\s)text-slate-500(?:\s|$)/.test(classes),
        ),
        `the neutral-200 scan cannot see: ${probe}`,
      ).toBe(true);
    }

    // …and it must not fire on a pairing that is split across two SEPARATE
    // elements, which is not a pairing at all.
    expect(
      classStringContexts(
        '<span className="bg-slate-200" /><span className="text-slate-500" />',
      ).some(
        (classes) =>
          /bg-slate-200/.test(classes) && /text-slate-500/.test(classes),
      ),
    ).toBe(false);
  });

  // #2145 — the prose in ARCHITECTURE.md previously claimed the derived tone was
  // guaranteed "on any app surface", which was never true: the guarantee is
  // over a finite, named list. Docs overclaiming what the code delivers has been
  // the recurring defect across this branch family, so the list is pinned rather
  // than trusted. Every checked surface must be NAMED in the doc section, and
  // every excluded one must be named as excluded.
  it("keeps the documented clamp surfaces in step with the ones the code checks", () => {
    const architecture = readRepoFile("docs/ARCHITECTURE.md");
    const start = architecture.indexOf(
      "**`--muted-foreground` is a DERIVED tone",
    );
    const section = architecture.slice(
      start,
      architecture.indexOf("Two contract tests in", start),
    );

    expect(start).toBeGreaterThan(0);
    expect(section).not.toHaveLength(0);

    for (const token of [
      ...APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS,
      ...APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS,
    ]) {
      expect(section, `${token} is checked but never named in the docs`).toContain(
        `\`${token}\``,
      );
    }

    const excluded = section.slice(section.indexOf("Deliberately **not** in"));
    for (const token of APP_MUTED_FOREGROUND_EXCLUDED_SURFACES) {
      expect(
        excluded,
        `${token} is excluded but the docs never say so`,
      ).toContain(`\`${token}\``);
      expect(
        APP_MUTED_FOREGROUND_LIGHT_SURFACE_TOKENS as readonly string[],
      ).not.toContain(token);
      expect(
        APP_MUTED_FOREGROUND_DARK_SURFACE_TOKENS as readonly string[],
      ).not.toContain(token);
    }

    // Whitespace-normalised, so a claim that happens to wrap across lines is
    // still caught. The un-normalised `toContain` this replaced would have
    // missed a wrapped occurrence of its own two banned phrases.
    const flat = section.replace(/\s+/g, " ");

    // The doc must not restate a claim the code does not deliver. The first two
    // are the absolute claims this section originally made. The rest are PARITY
    // claims, which are false BY CONSTRUCTION: the derived tone carries 0.41-0.59
    // of `--foreground`'s ratio on the shipped palettes, and being less readable
    // than `--foreground` is the entire point of the role. Re-wording an
    // overclaim rather than repeating one is what got past the first version of
    // this pin, so the positive shape assertions below matter more than this
    // list.
    for (const claim of [
      /on any app surface/i,
      /every background it can appear on/i,
      /never less readable than/i,
      /no less readable than/i,
      /at least as readable as/i,
      /as readable as `--foreground`/i,
      /never worse than `--foreground` on any surface/i,
    ]) {
      expect(flat, `docs restate an overclaim matching ${claim}`).not.toMatch(
        claim,
      );
    }

    // …and it must state the guarantee in its actual TWO-BRANCH shape, plus the
    // fact that the tone is deliberately weaker than `--foreground`. A future
    // edit that deletes the qualifications and leaves a bare claim fails here
    // even if it invents wording no ban above anticipates.
    expect(flat, "the AA branch of the guarantee is not stated").toMatch(
      /where `--foreground` itself clears 4\.5:1/i,
    );
    expect(flat, "the inherited-failure branch is not stated").toMatch(
      /where `--foreground` itself fails AA/i,
    );
    expect(flat, "the surfaces the guarantee covers are not bounded").toMatch(
      /in the table above/i,
    );
    expect(
      flat,
      "the docs do not say the tone is deliberately less readable than --foreground",
    ).toMatch(/deliberately LESS readable than `--foreground`/);
  });

  // #2145 — the site-style wizard preview overlays inline `--brand-*` values on
  // `app-theme-scope`. `--muted-foreground` does NOT resolve from those: it
  // resolves from the injected `--app-muted-foreground*` pair, so without these
  // two the preview paints the STATIC fallback (the DEFAULT palette's tone)
  // regardless of the palette being edited — on the one screen where an admin
  // evaluates the feature.
  it("feeds the derived muted tones into the site-style wizard preview", () => {
    const wizard = readRepoFile(
      "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
    );
    const preview = wizard.slice(
      wizard.indexOf("function previewStyle("),
      wizard.indexOf("export function SiteStyleWizard"),
    );

    expect(preview).toContain("deriveAppMutedForeground(values)");
    expect(preview).toContain('"--app-muted-foreground": muted.light');
    expect(preview).toContain('"--app-muted-foreground-dark": muted.dark');
    // The preview is applied to the element whose sample label is muted, so the
    // two must not drift apart.
    expect(wizard).toContain("previewStyle(values)");
    expect(wizard).toContain("text-muted-foreground");
  });

  it("keeps app brand utilities on solid gated text/background pairs", () => {
    const globals = readRepoFile("src/app/globals.css");
    const componentRules = globals.slice(
      globals.indexOf("@layer components"),
      globals.indexOf(".app-theme-scope {"),
    );

    for (const utility of [
      "app-brand-mark",
      "app-nav-link-active",
      "app-step-active",
      "app-chip-brand",
    ]) {
      const start = componentRules.indexOf(`.${utility} {`);
      const end = componentRules.indexOf("}", start);
      const rule = componentRules.slice(start, end);
      expect(rule).toContain("bg-brand-gold");
      expect(rule).toContain("text-brand-charcoal");
      expect(rule).not.toMatch(/bg-brand-gold\//);
      expect(rule).not.toContain("dark:text-brand-gold");
    }

    const calloutStart = componentRules.indexOf(".app-callout-brand {");
    const calloutEnd = componentRules.indexOf("}", calloutStart);
    const calloutRule = componentRules.slice(calloutStart, calloutEnd);
    expect(calloutRule).toContain("bg-card");
    expect(calloutRule).toContain("text-card-foreground");
    expect(calloutRule).not.toMatch(/bg-brand-gold\//);
  });

  it("uses semantic app text roles across admin navigation and setup surfaces", () => {
    const semanticTextFiles = [
      "src/app/(admin)/admin/booking-policies/page.tsx",
      "src/app/(admin)/admin/notifications/page.tsx",
      "src/app/(admin)/admin/roster/[date]/print/page.tsx",
      "src/app/(admin)/admin/setup/finance/page.tsx",
      "src/app/(admin)/admin/setup/setup-page-client.tsx",
      "src/app/(admin)/admin/site-style/page.tsx",
      "src/app/(admin)/admin/xero/page.tsx",
      // The Xero setup surface's markup moved to the client body when its page
      // became a thin server wrapper for the guided wizard (#2080); the semantic
      // text-role contract follows the markup.
      "src/app/(admin)/admin/xero/_components/xero-setup-page-client.tsx",
      "src/components/admin-hub-page.tsx",
      "src/components/admin/back-link.tsx",
    ];

    for (const path of semanticTextFiles) {
      const source = readRepoFile(path);
      expect(source, path).toContain("text-foreground");
      expect(source, path).not.toContain("text-brand-charcoal");
      expect(source, path).not.toContain("dark:text-brand-gold");
    }

    const wizard = readRepoFile(
      "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
    );
    expect(wizard).toContain(
      '"border-brand-gold bg-brand-gold text-brand-charcoal"',
    );
    expect(wizard).toContain(
      '<ActiveStepIcon className="h-5 w-5 text-foreground" />',
    );
    expect(wizard).not.toContain("bg-brand-gold/20 text-brand-charcoal");

    // This section's two Save buttons used to be raw <button> elements painted
    // with `bg-brand-charcoal text-brand-snow`, and the pin here existed to keep
    // the foreground on `text-brand-snow` rather than raw `text-white`. #2142
    // moved them onto the shared `ViewOnlyActionButton`/`Button`, whose default
    // variant is `bg-primary text-primary-foreground` — semantic tokens that
    // follow the club theme, which is strictly what the old pin was reaching
    // for. The pin is therefore restated as the stronger property: no raw brand
    // fill is hand-painted onto a control in this file at all.
    const publicRequests = readRepoFile(
      "src/components/admin/booking-policies/public-booking-requests-section.tsx",
    );
    expect(publicRequests).not.toMatch(/bg-brand-charcoal/);
    expect(publicRequests).not.toMatch(/text-white/);
    // Deliberately NOT a count of `<ViewOnlyActionButton`: how many gated
    // controls this section happens to have is not a theme contract, and pinning
    // it here would fail the day a third one is legitimately added. The
    // behaviour — that every Save in this section is gated — is covered where it
    // belongs, in `save-view-only-gating.test.tsx` (#2142 review).
  });

  it("keeps text-bearing calendar states off interpolated brand fills", () => {
    for (const path of [
      "src/components/admin/occupancy-calendar.tsx",
      "src/components/booking-calendar.tsx",
    ]) {
      const source = readRepoFile(path);
      expect(source, path).not.toMatch(
        /bg-brand-gold\/(?:10|15|20|25)[^"\n]*(?:text-|font-)/,
      );
      expect(source, path).not.toContain("dark:text-brand-gold");
    }
  });

  it("rejects endpoint-crossing opacity variants on app text surfaces", () => {
    // Both endpoint palettes pass the save gate, but Tailwind's transparent
    // composites cross back toward the foreground and fail AA.
    expect(contrastRatio("#757575", "#1a1a1a") ?? 21).toBeLessThan(4.5);
    expect(contrastRatio("#767676", "#737373") ?? 21).toBeLessThan(4.5);
    expect(contrastRatio("#767676", "#0c0c0c") ?? 21).toBeLessThan(4.5);
    expect(contrastRatio("#767676", "#726d6d") ?? 21).toBeLessThan(4.5);

    const appSources = [
      ...listSourceFiles("src/app/(admin)"),
      ...listSourceFiles("src/app/(authenticated)"),
      ...listSourceFiles("src/components"),
    ].filter((path) => {
      const normalized = path.replaceAll("\\", "/");
      return (
        !normalized.includes("/__tests__/") &&
        !normalized.includes("/website") &&
        normalized !== "src/components/ui/skeleton.tsx"
      );
    });
    const transparentAppBackground =
      /(?:^|[\s"'`])(?:hover:|active:|focus:|dark:|data-\[[^\]]+\]:)*bg-(?:background|foreground|card|popover|primary|secondary|muted|accent|brand-(?:gold|charcoal|deep|mist|snow))\/\d+/m;

    for (const path of appSources) {
      const source = readRepoFile(path);
      expect(source, path).not.toMatch(transparentAppBackground);
    }

    const button = readRepoFile("src/components/ui/button.tsx");
    const globals = readRepoFile("src/app/globals.css");
    const wizard = readRepoFile(
      "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
    );
    const themeSwitcher = readRepoFile("src/components/theme-switcher.tsx");
    expect(button).not.toContain("hover:bg-primary/90");
    expect(globals).not.toContain("hover:bg-brand-gold/90");
    expect(wizard).not.toContain("bg-muted/45");
    expect(themeSwitcher).not.toContain("text-foreground/75");

    const bedAllocationSources = listSourceFiles(
      "src/app/(admin)/admin/bed-allocation/_components",
    ).map(readRepoFile);
    expect(bedAllocationSources.join("\n")).not.toContain("tintClassName");
    expect(bedAllocationSources.join("\n")).not.toMatch(
      /bg-[a-z]+-50\/45|dark:bg-[a-z]+-950\/20/,
    );
  });

  it("keeps Site Style app chrome semantic while fixed code previews stay isolated", () => {
    const page = readRepoFile("src/app/(admin)/admin/site-style/page.tsx");
    const wizard = readRepoFile(
      "src/app/(admin)/admin/site-style/site-style-wizard.tsx",
    );

    expect(page).not.toMatch(/text-slate-(?:500|900)/);
    expect(wizard).not.toContain('className="text-lg font-semibold text-slate-900"');
    expect(wizard).not.toMatch(/text-sm (?:font-medium )?text-slate-(?:600|900)/);
    expect(wizard).not.toContain("text-xs font-medium text-slate-700");
    expect(wizard).toContain(
      "bg-slate-950 p-3 text-xs text-slate-100",
    );
    expect(wizard).toContain(
      "border border-slate-300 bg-white p-3 font-mono text-xs text-slate-900",
    );
  });
});
