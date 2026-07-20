import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

/*
  #2160 contract test — the ONE invariant the banner rollout must never break.

  `describeReason={false}` strips a control's own explanation of why it is
  gated: no `title`, no `aria-describedby`, no sr-only line. That is only an
  improvement when the surrounding section states the reason once, in the
  reading order, via `AdminViewOnlySectionBanner`. Opting a control out WITHOUT
  a covering banner deletes the explanation outright, which is strictly worse
  than the per-button affordance it replaced.

  A per-file check is what makes the property mechanically verifiable. Coverage
  is asserted within a single component, because that is the only scope where a
  reader (and this test) can see that the banner really does render above the
  control. A banner in some ancestor page MIGHT cover a child component's
  buttons, but nothing local proves the ancestor always renders it, so the rule
  is deliberately the strict one: opt out only where the banner is in the same
  file.
*/

const SRC = join(process.cwd(), "src");

// Plain recursive walk rather than a glob library: this is the only place in
// the repo that would need one, and knip rightly flags a dependency added for a
// single test.
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve an import specifier to the file it names, for the two forms this repo
 * uses for components: the `@/` alias and a relative path. Anything else (a
 * bare package specifier) resolves to null and is ignored — a node_module can
 * not render our banner.
 */
function resolveImport(fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;

  for (const candidate of [`${base}.tsx`, join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Whether the specific exported component `name` in `source` renders a banner,
 * as opposed to merely living in a file that contains one. File granularity is
 * too coarse: `page-content-panel.tsx` exports both `PageContentPanel` (which
 * renders a banner) and `WysiwygEditor` (a plain editor widget that does not),
 * and treating every import from that file as banner-bearing would flag two
 * innocent panels. This slices the named export's body — from its declaration
 * to the next top-level `export` — and looks for the banner inside it.
 */
function componentRendersBanner(source: string, name: string): boolean {
  const declRe = new RegExp(`^export\\s+(?:function|const)\\s+${name}\\b`, "m");
  const start = source.search(declRe);
  if (start === -1) return false;

  const rest = source.slice(start + 1);
  const nextExport = rest.search(/^export\s+(?:function|const|default)\b/m);
  const body = nextExport === -1 ? rest : rest.slice(0, nextExport);
  return body.includes("<AdminViewOnlySectionBanner");
}

/**
 * The opening tag of the FIRST `<Name` element in `source`, e.g.
 * `<AssignmentForm ... />`. Attribute values routinely contain `>` (arrow
 * functions: `onChanged={() => …}`), so the tag can not be matched with a
 * regex — this walks the text tracking brace depth and string literals, and
 * ends the tag at the first `>` that is outside both.
 */
function openingTag(source: string, name: string): string | null {
  const start = source.search(new RegExp(`<${name}\\b`));
  if (start === -1) return null;

  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return null;
}

function adminSourceFiles(): string[] {
  return walk(SRC)
    .filter((file) => {
      const rel = relative(SRC, file).split(sep).join("/");
      // `view-only-action.tsx` DEFINES the primitives and documents them, so its
      // JSDoc necessarily quotes `describeReason={false}` and `aria-disabled` as
      // prose. Scanning it would match the documentation rather than a call
      // site. Its own behaviour is pinned by the dedicated Decision 1 case below
      // and by `view-only-section-banner.test.tsx`.
      return rel.includes("admin") && !rel.endsWith("admin/view-only-action.tsx");
    });
}

describe("view-only section banner coverage (#2160)", () => {
  const files = adminSourceFiles().map((file) => ({
    file,
    rel: relative(SRC, file).split(sep).join("/"),
    source: readFileSync(file, "utf8"),
  }));

  it("finds the admin surfaces it is meant to police", () => {
    // Guards against the glob silently matching nothing after a tree move,
    // which would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(
      files.filter((f) => f.source.includes("<ViewOnlyActionButton")).length,
    ).toBeGreaterThan(50);
  });

  it("never strips a control's reason without a banner covering it", () => {
    const offenders = files
      .filter((f) => f.source.includes("describeReason={false}"))
      .filter((f) => !f.source.includes("<AdminViewOnlySectionBanner"))
      .map((f) => f.rel);

    expect(
      offenders,
      `These files opt a ViewOnlyActionButton out of its own view-only reason ` +
        `(describeReason={false}) but render no <AdminViewOnlySectionBanner>. ` +
        `That deletes the explanation entirely. Either add the section banner ` +
        `or drop the describeReason opt-out.`,
    ).toEqual([]);
  });

  it("never nests one banner-bearing component inside another", () => {
    /*
      The coverage rule above is asserted per FILE by text presence, so it is
      blind BY CONSTRUCTION to the opposite defect: two banners covering the
      same controls. A page that renders its own banner and then renders a
      child component that renders one too shows a view-only admin the same
      sentence twice, in two `role="status"` regions, both announced.

      Both halves are static and reliable: a file's imports name the component
      files it can render, and the render site itself carries the opt-out. A
      child that is legitimately reused in a container no ancestor banner
      reaches (a dialog) keeps its own banner by default; the parent that DOES
      cover it passes `renderViewOnlyBanner={false}` at the render site, which
      is exactly where a reader needs to see it.
    */
    const bannerFiles = new Set(
      files.filter((f) => f.source.includes("<AdminViewOnlySectionBanner")).map((f) => f.file),
    );

    const offenders: string[] = [];
    for (const parent of files) {
      if (!bannerFiles.has(parent.file)) continue;

      const importRe =
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
      for (const match of parent.source.matchAll(importRe)) {
        const target = resolveImport(parent.file, match[2]);
        if (!target || !bannerFiles.has(target) || target === parent.file) continue;

        for (const raw of match[1].split(",")) {
          const spec = raw.trim();
          // `type Foo` / `Foo as Bar` are not renderable component bindings.
          if (!spec || spec.startsWith("type ") || spec.includes(" as ")) continue;
          if (!/^[A-Z]\w*$/.test(spec)) continue;

          const tag = openingTag(parent.source, spec);
          if (!tag) continue; // imported but never rendered here
          if (tag.includes("renderViewOnlyBanner={false}")) continue;
          // The file has a banner somewhere; only THIS export matters.
          const childSource = readFileSync(target, "utf8");
          if (!componentRendersBanner(childSource, spec)) continue;

          offenders.push(
            `${parent.rel} renders <${spec}> from ${relative(SRC, target).split(sep).join("/")}`,
          );
        }
      }
    }

    expect(
      offenders,
      `These components render an AdminViewOnlySectionBanner AND render a ` +
        `child component that renders one too, so a view-only admin meets the ` +
        `same sentence twice in two live regions. Decide which container owns ` +
        `the explanation: if the parent's banner covers the child's controls, ` +
        `pass renderViewOnlyBanner={false} at the child's render site; ` +
        `otherwise drop the parent's banner.`,
    ).toEqual([]);
  });

  it("keeps every banner's live region mounted above the loading early-return", () => {
    /*
      The banner only announces if its `role="status"` wrapper is registered in
      the accessibility tree BEFORE its content appears. A section that renders
      the banner solely in its loaded branch mounts it already-populated, which
      some screen-reader/browser pairings drop silently (VoiceOver + Safari).

      Statically, the tell is the shared idiom: sections with a loading
      early-return hoist the banner into a `const ...Banner = (...)` and render
      that const in BOTH branches. So a file that has an early return AND names
      the banner inline exactly once is the shape that fails.

      The guard is deliberately broader than the literal lower-case word
      `loading`. This defect has recurred repeatedly across the banner work,
      and the early return that causes it gets spelled several ways:
      `isLoading`, `isPending`, `isFetching`, `status === "loading"`. Matching
      case-insensitively and naming those identifiers keeps the guard ahead of
      the idiom rather than pinned to one spelling of it. (It is deliberately
      NOT widened to every `if (!x) return` data guard: those are overwhelmingly
      handler preconditions rather than render early-returns, and including
      them flags four compliant files.)

      Two things make a file compliant, and both are checked. The banner must
      be rendered in at least TWO places — the hoisted-const-in-both-branches
      idiom — and its definition must sit ABOVE the early return. The second is
      what makes the proxy positional rather than presence-only: a file that
      defines the banner after the early return cannot possibly render it in
      the loading branch, however many times it renders it below.
    */
    const earlyReturn =
      /if\s*\([^)]*(\bloading\b|\bis(Loading|Pending|Fetching)\b|status\s*===\s*["']loading["'])[^)]*\)\s*(\{[\s\S]{0,80}?)?return/i;
    const offenders = files
      .filter((f) => f.source.includes("<AdminViewOnlySectionBanner"))
      .filter((f) => earlyReturn.test(f.source))
      .filter((f) => {
        const renders = f.source.match(/\{\s*\w*[Bb]anner\s*\}/g)?.length ?? 0;
        // Hoisted-and-reused (>= 2 render sites) is the compliant shape.
        if (renders < 2) return true;
        // …and the hoisted const has to precede the early return it survives.
        return (
          f.source.search(/<AdminViewOnlySectionBanner/) >
          f.source.search(earlyReturn)
        );
      })
      .map((f) => f.rel);

    expect(
      offenders,
      `These files have a loading early-return but do not render the hoisted ` +
        `banner const in both branches, so the live region is not registered ` +
        `until the section's fetch settles.`,
    ).toEqual([]);
  });
});

describe("gated controls keep `disabled` (#2160 Decision 1)", () => {
  it("does not switch ViewOnlyActionButton to aria-disabled", () => {
    /*
      Owner Decision 1 on #2160: KEEP `disabled`. The known, accepted cost is
      that gated controls stay OUT of the keyboard tab order — the banner puts
      the reason in the reading order, but it does not make the control
      focusable. If someone later swaps in `aria-disabled`, that is a real
      behaviour change (a clickable control that must be neutralised) and it
      needs a fresh owner decision, not a silent edit.
    */
    const source = readFileSync(
      join(SRC, "components", "admin", "view-only-action.tsx"),
      "utf8",
    );
    // Strip comments first: the JSDoc DISCUSSES `aria-disabled` at length —
    // explaining what was weighed and declined — so matching raw source would
    // fail on the documentation that exists precisely to record this decision.
    // Only the code is the contract.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    expect(code).toContain("disabled={isDisabled}");
    expect(code).not.toMatch(/aria-disabled/);
  });
});
