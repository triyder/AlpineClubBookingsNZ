import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
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

/**
 * `source` with every comment blanked out — each comment character replaced by
 * a space, newlines kept — so offsets and line numbers still line up with the
 * file on disk.
 *
 * Every check below asks "does this file CONTAIN this text", and raw text can
 * not tell a call site from prose ABOUT a call site. That distinction has now
 * bitten this branch twice, both times inflating the published counts by one:
 * `view-only-action.tsx`'s JSDoc quotes `describeReason={false}` while
 * documenting when to pass it, and `public-booking-requests-section.tsx`
 * carries a JSX comment narrating the #2142 conversion that quotes it too.
 *
 * Excluding those two files by name would only postpone the third instance, so
 * the strip is structural instead. It uses TypeScript's own scanner — the same
 * lexer the compiler runs — because a regex can not reliably tell a comment
 * from a `/*` inside a string, a template literal, or a regex literal, and a
 * naive JSX-comment pattern (`\{\s*\/\*[\s\S]*?\*\/\s*\}`) silently swallows an
 * object type that merely OPENS with a JSDoc member comment, taking the real
 * call sites inside it along with the prose.
 */
function stripComments(source: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    /* skipTrivia */ false,
    ts.LanguageVariant.JSX,
    source,
  );
  const chars = source.split("");
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (
      token === ts.SyntaxKind.SingleLineCommentTrivia ||
      token === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      for (let i = scanner.getTokenStart(); i < scanner.getTokenEnd(); i += 1) {
        if (chars[i] !== "\n") chars[i] = " ";
      }
    }
    token = scanner.scan();
  }
  return chars.join("");
}

// Plain recursive walk rather than a glob library: this is the only place in
// the repo that would need one, and knip rightly flags a dependency added for a
// single test. (`typescript` is already a devDependency — the scanner above
// reuses it rather than adding anything.)
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
 * The opening tag of EVERY `<Name` element in `source`, e.g.
 * `<AssignmentForm ... />`. Attribute values routinely contain `>` (arrow
 * functions: `onChanged={() => …}`), so a tag can not be matched with a
 * regex — this walks the text tracking brace depth and string literals, and
 * ends each tag at the first `>` that is outside both.
 *
 * Every render site is returned, not just the first. Checking only the first
 * made the nesting rule below evadable in exactly the likeliest direction: a
 * second, un-opted-out `<Child>` added BELOW an existing compliant one — the
 * shape you get by copying a working render site and dropping the prop — was
 * never looked at, so the earlier compliant site kept the suite green.
 */
function openingTags(source: string, name: string): string[] {
  const tags: string[] = [];
  for (const match of source.matchAll(new RegExp(`<${name}\\b`, "g"))) {
    const start = match.index;
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
      else if (char === ">" && depth === 0) {
        tags.push(source.slice(start, i + 1));
        break;
      }
    }
  }
  return tags;
}

function adminSourceFiles(): string[] {
  return walk(SRC).filter((file) =>
    relative(SRC, file).split(sep).join("/").includes("admin"),
  );
}

describe("view-only section banner coverage (#2160)", () => {
  // `source` is the file with its comments blanked out. Every assertion in this
  // suite is a text search, so it has to run against code only — see
  // `stripComments`. That is also why `view-only-action.tsx` needs no special
  // case here even though its JSDoc quotes `describeReason={false}` at length,
  // and why the counts below can be trusted: the prose is gone before anything
  // is matched.
  const files = adminSourceFiles().map((file) => ({
    file,
    rel: relative(SRC, file).split(sep).join("/"),
    source: stripComments(readFileSync(file, "utf8")),
  }));

  it("finds the admin surfaces it is meant to police", () => {
    // Guards against the glob silently matching nothing after a tree move,
    // which would make every assertion below vacuously pass.
    expect(files.length).toBeGreaterThan(50);
    expect(
      files.filter((f) => f.source.includes("<ViewOnlyActionButton")).length,
    ).toBeGreaterThan(50);
  });

  it("matches the coverage figures the docs publish", () => {
    /*
      Four documents and one JSDoc block quote these numbers as fact:
      `docs/ARCHITECTURE.md`, `AGENTS.md`, `docs/STYLE_GUIDE.md`,
      `CHANGELOG.md`, and `ViewOnlyActionButton`'s own JSDoc in
      `src/components/admin/view-only-action.tsx`.

      They were counted by hand, from raw text, and came out one too high —
      twice, for the same reason both times: a `describeReason={false}` written
      inside a comment counted as a call site. Nothing structural stopped a
      third instance, so this pins them. `files` is comment-stripped (see
      `stripComments`), which is what makes the count mean "call sites" rather
      than "mentions".

      This test is MEANT to fail when the rollout changes. Adding or converting
      a gated control is a real change to a published figure, and the fix is to
      re-run the numbers and update all five places together — never to loosen
      the assertion.
    */
    const perFile = files.map((f) => ({
      rel: f.rel,
      sites: f.source.match(/<ViewOnlyActionButton\b/g)?.length ?? 0,
      optOuts: f.source.match(/describeReason=\{false\}/g)?.length ?? 0,
    }));
    const sum = (list: { n: number }[]) => list.reduce((n, f) => n + f.n, 0);

    // Controls that KEEP the per-button reason, per file.
    const exceptions = perFile
      .map((f) => ({ rel: f.rel, n: f.sites - f.optOuts }))
      .filter((f) => f.n > 0);

    expect({
      callSites: perFile.reduce((n, f) => n + f.sites, 0),
      optOuts: perFile.reduce((n, f) => n + f.optOuts, 0),
      exceptions: sum(exceptions),
      exceptionFiles: exceptions.length,
      bannerComponents: files.filter((f) =>
        f.source.includes("<AdminViewOnlySectionBanner"),
      ).length,
    }).toEqual({
      callSites: 256,
      optOuts: 203,
      exceptions: 53,
      exceptionFiles: 23,
      bannerComponents: 72,
    });

    /*
      …and the three shapes those exceptions fall into, because the docs break
      the total down and a bucket can drift while the total holds. The member
      detail cards are listed by name rather than by directory: three OTHER
      files in that same folder (`member-detail-header`,
      `member-account-access-group`, `member-contact-group`) are leaf toolbars,
      not per-record cards, and belong in the leaf bucket.
    */
    const MEMBER_DETAIL_CARDS = [
      "member-committee-assignments-card",
      "member-credit-card",
      "member-deletion-card",
      "member-dependents-card",
      "member-lifecycle-card",
      "member-lodge-access-card",
      "member-parent-links-card",
      "member-partner-link-card",
      "member-seasonal-membership-card",
    ].map((name) => `app/(admin)/admin/members/[id]/_components/${name}.tsx`);

    // Controls inside a dialog, sheet, popover, or dropdown menu — a separate
    // accessibility container that a banner in the page body does not reach.
    const SEPARATE_A11Y_CONTAINER = [
      "app/(admin)/admin/bookings/page.tsx",
      "app/(admin)/admin/issue-reports/page.tsx",
      "app/(admin)/admin/member-applications/_components/approval-mapping-panel.tsx",
      "app/(admin)/admin/membership-types/page.tsx",
    ];

    const bucket = (names: string[]) =>
      exceptions.filter((f) => names.includes(f.rel));
    const leaves = exceptions.filter(
      (f) =>
        !MEMBER_DETAIL_CARDS.includes(f.rel) &&
        !SEPARATE_A11Y_CONTAINER.includes(f.rel),
    );

    expect({
      memberDetailCards: {
        controls: sum(bucket(MEMBER_DETAIL_CARDS)),
        files: bucket(MEMBER_DETAIL_CARDS).length,
      },
      separateA11yContainer: {
        controls: sum(bucket(SEPARATE_A11Y_CONTAINER)),
        files: bucket(SEPARATE_A11Y_CONTAINER).length,
      },
      leaves: { controls: sum(leaves), files: leaves.length },
    }).toEqual({
      memberDetailCards: { controls: 25, files: 9 },
      separateA11yContainer: { controls: 9, files: 4 },
      leaves: { controls: 19, files: 10 },
    });
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

      A child that is legitimately reused in a container no ancestor banner
      reaches (a dialog) keeps its own banner by default; the parent that DOES
      cover it passes `renderViewOnlyBanner={false}` at the render site, which
      is exactly where a reader needs to see it. EVERY render site of the child
      is checked, not just the first, so a second copy added below a compliant
      one can not ride on it.

      The scan is static, and its reach is exactly the house style it polices:
      a named import (`import { Child } from "…"`) rendered as `<Child …>`. It
      does NOT see a component reached by an aliased import
      (`import { Child as Editor }`), a default import, a barrel re-export, or
      `next/dynamic`. None of those are used for banner-bearing admin
      components today — every pair that currently exists is checked — but a
      future refactor to one of those forms would take the pair out of this
      test's view rather than fail it.
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

          const tags = openingTags(parent.source, spec);
          if (tags.length === 0) continue; // imported but never rendered here
          const uncovered = tags.filter(
            (tag) => !tag.includes("renderViewOnlyBanner={false}"),
          );
          if (uncovered.length === 0) continue;
          // The file has a banner somewhere; only THIS export matters.
          const childSource = stripComments(readFileSync(target, "utf8"));
          if (!componentRendersBanner(childSource, spec)) continue;

          offenders.push(
            `${parent.rel} renders <${spec}> from ${relative(SRC, target).split(sep).join("/")} ` +
              `(${uncovered.length} of ${tags.length} render site(s) without renderViewOnlyBanner={false})`,
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
