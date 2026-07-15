import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_DISPLAY_LAYOUTS,
  BUILT_IN_DISPLAY_TEMPLATES,
  ensureBuiltInDisplays,
  isBuiltInDisplayLayoutKey,
  isBuiltInDisplayTemplateKey,
  type EnsureBuiltInDisplaysClient,
} from "@/lib/lodge-display/built-in-seeds";

// LTV-038: the three built-ins seeded as v2 Layout + Template rows. These tests
// cover the SEED CONTRACT (create-if-missing, admin-safe, idempotent), without a
// database — a structural mock captures the upsert shapes. The legacy device
// `templateKey`→`templateId` migration was removed in #86 (LTV-040) along with
// the device column. The layout-render VALIDITY of the seeded definitions (they
// build cleanly through the real server assembler) is asserted in
// lodge-display-layout-render.test.ts's LTV-038 block.

interface UpsertCall {
  where: { key: string };
  update: Record<string, unknown>;
  create: {
    id: string;
    key: string;
    layoutId?: string;
    bodyHtml?: unknown;
    areas?: unknown;
    slotContent?: unknown;
  };
}

function makeClient() {
  const layoutUpserts: UpsertCall[] = [];
  const templateUpserts: UpsertCall[] = [];
  const client: EnsureBuiltInDisplaysClient = {
    displayLayout: {
      upsert: vi.fn(async (args) => {
        layoutUpserts.push(args as unknown as UpsertCall);
        return { id: (args.create as { id: string }).id };
      }),
    },
    displayTemplate: {
      upsert: vi.fn(async (args) => {
        templateUpserts.push(args as unknown as UpsertCall);
        return { id: (args.create as { id: string }).id };
      }),
    },
  };
  return { client, layoutUpserts, templateUpserts };
}

describe("built-in display seeds — definitions", () => {
  it("defines exactly the three built-ins keyed to the legacy code built-ins", () => {
    expect(BUILT_IN_DISPLAY_LAYOUTS.map((l) => l.key)).toEqual([
      "everyday-board",
      "whole-lodge",
      "singles-house",
    ]);
    expect(BUILT_IN_DISPLAY_TEMPLATES.map((t) => t.key)).toEqual([
      "everyday-board",
      "whole-lodge",
      "singles-house",
    ]);
    // Every template binds a layout that exists in the seed set.
    for (const template of BUILT_IN_DISPLAY_TEMPLATES) {
      expect(
        BUILT_IN_DISPLAY_LAYOUTS.some((l) => l.key === template.layoutKey)
      ).toBe(true);
    }
  });

  it("carries per-area defaultContent on the everyday-board static/conditional areas (issue #111)", () => {
    const everyday = BUILT_IN_DISPLAY_LAYOUTS.find(
      (l) => l.key === "everyday-board"
    )!;
    const byKey = Object.fromEntries(everyday.areas.map((a) => [a.key, a]));
    // Each static/conditional area declares its default module so the authoring
    // editor seeds a NEW template's slots from the real default, not an empty box.
    expect(byKey.board.defaultContent).toEqual({
      module: "arrivals-board",
      options: { days: 3 },
    });
    expect(byKey.chores.defaultContent).toEqual({ module: "chores-board" });
    expect(byKey.rules.defaultContent).toEqual({ module: "lodge-rules" });
    expect(byKey.notice.defaultContent).toEqual({ module: "notice-board" });
    // The defaults mirror the matching built-in template's slot bindings exactly.
    const everydayTemplate = BUILT_IN_DISPLAY_TEMPLATES.find(
      (t) => t.key === "everyday-board"
    )!;
    for (const area of everyday.areas) {
      if (area.kind !== "rotator") {
        expect(area.defaultContent).toEqual(everydayTemplate.slotContent[area.key]);
      }
    }
  });

  it("leaves rotator built-ins' children without defaultContent (a documented follow-up)", () => {
    // whole-lodge / singles-house are rotator layouts; the validator rejects
    // defaultContent on a rotator area, and DisplayAreaChild has no such field
    // yet, so their child slots still seed empty (issue #111 follow-up).
    for (const key of ["whole-lodge", "singles-house"]) {
      const layout = BUILT_IN_DISPLAY_LAYOUTS.find((l) => l.key === key)!;
      for (const area of layout.areas) {
        expect(area.defaultContent).toBeUndefined();
      }
    }
  });

  it("re-creates the everyday-board board+rail page grid in the layout CSS", () => {
    const everyday = BUILT_IN_DISPLAY_LAYOUTS.find(
      (l) => l.key === "everyday-board"
    )!;
    // The two-column board+rail treatment (legacy .display-screen:has(side)) and
    // the stacked rail (legacy .display-region-stack) live in the layout CSS now.
    expect(everyday.defaultCss).toContain("grid-template-columns: 1fr 27vw");
    expect(everyday.defaultCss).toContain(".eb-rail");
    // The compact notice-card treatment travels too.
    expect(everyday.defaultCss).toContain(".eb-rail .display-notice-board");
    // The body nests the rail areas inside a rail container (LTV-041 nesting).
    expect(everyday.bodyHtml).toContain('<div class="eb-rail">');
    expect(everyday.bodyHtml).toContain("{{area:chores}}");
    expect(everyday.bodyHtml).toContain("{{area:notice}}");
  });
});

describe("ensureBuiltInDisplays — seed contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts each layout and template refreshing its definition from code (owner decision A, #111)", async () => {
    const { client, layoutUpserts, templateUpserts } = makeClient();
    await ensureBuiltInDisplays(client);

    expect(layoutUpserts).toHaveLength(3);
    expect(templateUpserts).toHaveLength(3);
    // Code-managed scaffolding: the update REWRITES the definition (not empty),
    // so a re-seed propagates design improvements to already-seeded rows, and it
    // matches the create body so an existing row converges on the shipped design.
    for (const call of layoutUpserts) {
      expect(call.where.key).toBe(call.create.key);
      expect(call.update).not.toEqual({});
      expect((call.update as { areas?: unknown }).areas).toEqual(call.create.areas);
      expect((call.update as { bodyHtml?: unknown }).bodyHtml).toBe(call.create.bodyHtml);
    }
    for (const call of templateUpserts) {
      expect(call.where.key).toBe(call.create.key);
      expect(call.update).not.toEqual({});
      expect((call.update as { slotContent?: unknown }).slotContent).toEqual(
        call.create.slotContent
      );
      expect((call.update as { layoutId?: string }).layoutId).toBe(call.create.layoutId);
    }
    // Templates bind their layout by the resolved (here deterministic) id.
    const everydayTemplate = templateUpserts.find(
      (c) => c.create.key === "everyday-board"
    )!;
    expect(everydayTemplate.create.layoutId).toBe("builtin-layout-everyday-board");
  });

  it("is idempotent: a second run re-issues the same definition-refresh upserts", async () => {
    // A populated DB: layouts/templates already exist; each re-seed rewrites them
    // to match code (converging, not clobbering with drift), so the operation is
    // safe to repeat on every deploy.
    const { client, layoutUpserts, templateUpserts } = makeClient();
    await ensureBuiltInDisplays(client);
    await ensureBuiltInDisplays(client);

    expect(layoutUpserts).toHaveLength(6);
    expect(templateUpserts).toHaveLength(6);
    for (const call of [...layoutUpserts, ...templateUpserts]) {
      expect(call.update).not.toEqual({});
    }
  });
});

describe("built-in key detection (#156)", () => {
  // The authoring editors warn + confirm before an in-place built-in edit; the
  // signal is the reserved KEY, because `ensureBuiltInDisplays` matches on key
  // (the deterministic `builtin-*` id is only for a fresh create).
  it("recognises every seeded layout/template key as a built-in", () => {
    for (const layout of BUILT_IN_DISPLAY_LAYOUTS) {
      expect(isBuiltInDisplayLayoutKey(layout.key)).toBe(true);
    }
    for (const template of BUILT_IN_DISPLAY_TEMPLATES) {
      expect(isBuiltInDisplayTemplateKey(template.key)).toBe(true);
    }
  });

  it("treats a custom (non-reserved) key as not built-in", () => {
    expect(isBuiltInDisplayLayoutKey("foyer-board")).toBe(false);
    expect(isBuiltInDisplayTemplateKey("foyer-board")).toBe(false);
    expect(isBuiltInDisplayLayoutKey("")).toBe(false);
  });
});
