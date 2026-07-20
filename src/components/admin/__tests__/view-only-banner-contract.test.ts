import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import fg from "fast-glob";
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

function adminSourceFiles(): string[] {
  return fg
    .sync(["**/*.tsx"], {
      cwd: SRC,
      absolute: true,
      ignore: ["**/__tests__/**", "**/*.test.tsx"],
    })
    .filter((file) => {
      const rel = relative(SRC, file).split(sep).join("/");
      return rel.includes("admin");
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
    */
    const offenders = files
      .filter((f) => f.source.includes("<AdminViewOnlySectionBanner"))
      .filter((f) => /if\s*\([^)]*loading[^)]*\)\s*(\{[\s\S]{0,80}?)?return/.test(f.source))
      .filter((f) => {
        const renders = f.source.match(/\{\s*\w*[Bb]anner\s*\}/g)?.length ?? 0;
        // Hoisted-and-reused (>= 2 render sites) is the compliant shape.
        return renders < 2;
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
    expect(source).toContain("disabled={isDisabled}");
    expect(source).not.toContain('aria-disabled');
  });
});
