import { describe, expect, it } from "vitest";
import {
  InvalidDisplayLayoutError,
  splitLayoutBody,
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  validateHtmlModuleEmbeds,
  type DisplayAreaDefinition,
} from "@/lib/lodge-display/layout-registry";

// LTV-027: the Layout/Template validators (client-safe, prisma-free). They pin
// the LTV-024 `areas`/`slotContent` Json contract — placeholder/area bijection,
// slug/kind/condition/rotateSeconds/children rules, module/options validation,
// and unknown-slot rejection — with the same fail-fast stance as the legacy
// template validator (a broken layout is never accepted partially).

describe("splitLayoutBody", () => {
  it("splits a body into ordered html and area segments", () => {
    const segments = splitLayoutBody("<h1>Hi</h1>{{area:main}}<hr/>{{area:side}}");
    expect(segments).toEqual([
      { type: "html", html: "<h1>Hi</h1>" },
      { type: "area", key: "main" },
      { type: "html", html: "<hr/>" },
      { type: "area", key: "side" },
    ]);
  });

  it("handles a leading placeholder and no trailing html", () => {
    expect(splitLayoutBody("{{area:only}}")).toEqual([{ type: "area", key: "only" }]);
  });

  it("is not stateful across calls (fresh regex each time)", () => {
    const body = "{{area:a}}";
    expect(splitLayoutBody(body)).toEqual(splitLayoutBody(body));
  });
});

describe("validateDisplayLayoutDefinition", () => {
  const staticArea: DisplayAreaDefinition = {
    key: "main",
    description: "Main",
    kind: "static",
  };

  it("accepts a matched body + areas and returns typed areas", () => {
    const areas = validateDisplayLayoutDefinition("{{area:main}}", [staticArea]);
    expect(areas).toHaveLength(1);
    expect(areas[0].kind).toBe("static");
  });

  it("rejects a placeholder with no matching area entry", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}{{area:ghost}}", [staticArea])
    ).toThrow(InvalidDisplayLayoutError);
  });

  it("rejects an area with no placeholder in the body", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        staticArea,
        { key: "orphan", description: "x", kind: "static" },
      ])
    ).toThrow(/no \{\{area:orphan\}\} placeholder/);
  });

  it("rejects a duplicate placeholder for the same area", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}{{area:main}}", [staticArea])
    ).toThrow(/more than once/);
  });

  it("rejects a bad area key slug", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:Main}}", [
        { key: "Main", description: "x", kind: "static" },
      ])
    ).toThrow(/lower-case slug/);
  });

  it("rejects a duplicate area key", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [staticArea, staticArea])
    ).toThrow(/duplicate area key/);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        { key: "main", description: "x", kind: "wobble" as never },
      ])
    ).toThrow(/kind must be/);
  });

  it("requires a condition on a conditional area and validates it", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        { key: "main", description: "x", kind: "conditional" },
      ])
    ).toThrow(/unknown condition/);
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        { key: "main", description: "x", kind: "conditional", condition: "not:real" },
      ])
    ).toThrow(/unknown condition/);
    const ok = validateDisplayLayoutDefinition("{{area:main}}", [
      { key: "main", description: "x", kind: "conditional", condition: "content:notice" },
    ]);
    expect(ok[0].condition).toBe("content:notice");
  });

  it("forbids a condition on a non-conditional area", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        { key: "main", description: "x", kind: "static", condition: "content:notice" },
      ])
    ).toThrow(/only set a condition when kind is "conditional"/);
  });

  it("defaults rotateSeconds and enforces its 3-300 bound", () => {
    const ok = validateDisplayLayoutDefinition("{{area:main}}", [
      {
        key: "main",
        description: "x",
        kind: "rotator",
        children: [{ key: "a", description: "A" }],
      },
    ]);
    expect(ok[0].rotateSeconds).toBe(8);

    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        {
          key: "main",
          description: "x",
          kind: "rotator",
          rotateSeconds: 1,
          children: [{ key: "a", description: "A" }],
        },
      ])
    ).toThrow(/rotateSeconds must be 3-300/);
  });

  it("requires at least one rotator child and validates child keys/conditions", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        { key: "main", description: "x", kind: "rotator", children: [] },
      ])
    ).toThrow(/at least one child/);

    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        {
          key: "main",
          description: "x",
          kind: "rotator",
          children: [{ key: "a", description: "A", condition: "bogus" }],
        },
      ])
    ).toThrow(/unknown condition/);

    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        {
          key: "main",
          description: "x",
          kind: "rotator",
          children: [
            { key: "a", description: "A" },
            { key: "a", description: "again" },
          ],
        },
      ])
    ).toThrow(/duplicate child key/);
  });

  it("forbids children/rotateSeconds on a static area and defaultContent on a rotator", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        { key: "main", description: "x", kind: "static", rotateSeconds: 10 },
      ])
    ).toThrow(/only a rotator may set rotateSeconds/);

    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        {
          key: "main",
          description: "x",
          kind: "rotator",
          children: [{ key: "a", description: "A" }],
          defaultContent: { html: "nope" },
        },
      ])
    ).toThrow(/rotator may not set defaultContent/);
  });

  it("validates a static area's defaultContent as slot content", () => {
    expect(() =>
      validateDisplayLayoutDefinition("{{area:main}}", [
        {
          key: "main",
          description: "x",
          kind: "static",
          defaultContent: { module: "nope" as never },
        },
      ])
    ).toThrow(/unknown module/);
  });
});

describe("validateDisplaySlotContent", () => {
  const areas = validateDisplayLayoutDefinition("{{area:main}}{{area:carousel}}", [
    { key: "main", description: "Main", kind: "static" },
    {
      key: "carousel",
      description: "Carousel",
      kind: "rotator",
      children: [
        { key: "one", description: "One" },
        { key: "two", description: "Two" },
      ],
    },
  ]);

  it("accepts html, module (with scalar options), and rotator child slots", () => {
    const ok = validateDisplaySlotContent(areas, {
      main: { html: "<p>Hello</p>" },
      "carousel/one": { module: "welcome" },
      "carousel/two": { module: "arrivals-board", options: { days: 3 } },
    });
    expect(Object.keys(ok)).toHaveLength(3);
  });

  it("rejects an unknown slot key", () => {
    expect(() =>
      validateDisplaySlotContent(areas, { "carousel/three": { html: "x" } })
    ).toThrow(/unknown slot key/);
  });

  it("rejects the bare rotator area key (children carry the content)", () => {
    expect(() =>
      validateDisplaySlotContent(areas, { carousel: { html: "x" } })
    ).toThrow(/unknown slot key "carousel"/);
  });

  it("rejects an unknown module and non-scalar options", () => {
    expect(() =>
      validateDisplaySlotContent(areas, { main: { module: "not-a-module" } })
    ).toThrow(/unknown module/);
    expect(() =>
      validateDisplaySlotContent(areas, {
        "carousel/one": { module: "welcome", options: { bad: { nested: 1 } } },
      })
    ).toThrow(/must be a scalar/);
  });

  it("rejects content with neither html nor module", () => {
    expect(() =>
      validateDisplaySlotContent(areas, { main: { nonsense: true } })
    ).toThrow(/needs either "html" or "module"/);
  });
});

describe("validateHtmlModuleEmbeds (LTV-028)", () => {
  it("accepts a well-formed embed of a known module", () => {
    expect(() =>
      validateHtmlModuleEmbeds("<p>x</p>{{module:chores-board}}", "slot")
    ).not.toThrow();
  });

  it("accepts html with no embed at all", () => {
    expect(() => validateHtmlModuleEmbeds("<p>no tokens</p>", "slot")).not.toThrow();
  });

  it("rejects an unknown module name (fail fast on a typo)", () => {
    expect(() =>
      validateHtmlModuleEmbeds("{{module:not-a-module}}", "slot")
    ).toThrow(/unknown module/);
  });

  it("rejects a spaced form and an arguments form (no options in embeds)", () => {
    expect(() =>
      validateHtmlModuleEmbeds("{{module: welcome }}", "slot")
    ).toThrow(/malformed module embed/);
    expect(() =>
      validateHtmlModuleEmbeds("{{module:welcome(days:3)}}", "slot")
    ).toThrow(/malformed module embed/);
  });

  it("is reached through validateDisplaySlotContent for slot html", () => {
    const one = validateDisplayLayoutDefinition("{{area:main}}", [
      { key: "main", description: "Main", kind: "static" },
    ]);
    expect(() =>
      validateDisplaySlotContent(one, { main: { html: "{{module:nope}}" } })
    ).toThrow(/unknown module/);
    expect(() =>
      validateDisplaySlotContent(one, {
        main: { html: "{{module:arrivals-board}}" },
      })
    ).not.toThrow();
  });
});
