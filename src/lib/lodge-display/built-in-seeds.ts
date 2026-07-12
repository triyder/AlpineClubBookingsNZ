import type { Prisma } from "@prisma/client";
import {
  validateDisplayLayoutDefinition,
  validateDisplaySlotContent,
  type DisplayAreaDefinition,
  type DisplaySlotContentMap,
} from "./layout-registry";

// Built-in lobby-display designs, re-expressed as v2 Layout + Template rows
// (LTV-038, ADR-003 §1 Consequences "Redone"). The MVP shipped three code
// built-ins (everyday-board / whole-lodge / singles-house) as region/panel
// definitions resolved by their registry key (template-registry.ts). This module
// re-expresses the SAME three designs in the v2 shapes — an HTML Layout with
// named areas + a Template that fills those areas with library modules — and
// SEEDS them create-if-missing so they become ordinary, admin-editable rows.
//
// Visual parity (the acceptance criterion): the module components render
// identically (their CSS in display.css is untouched); each Layout's `defaultCss`
// re-creates the PAGE-GRID treatments the legacy `.display-screen` region grid
// carried (the two-column board+rail treatment from `.display-screen:has(
// .display-region-side)`, the stacked side-rail from `.display-region-stack`,
// and the compact notice-card treatment) so the rendered boards match the
// LTV-015/016 approved mocks. The v2 area model has rotator areas but NOT the
// legacy "stack" layout, so the everyday-board side rail becomes three ADJACENT
// areas inside a rail container div in the layout body (nesting works since
// LTV-041/#96); whole-lodge and singles keep their rotation as rotator areas.
//
// SEED CONTRACT (create-if-missing, admin-safe): `ensureBuiltInDisplays` upserts
// each Layout/Template by its unique `key` with an EMPTY update, so a re-run
// never clobbers an admin who customised a built-in — they keep their version.
// Devices bind to these seeded rows by `templateId`; the legacy device
// `templateKey` column and its one-shot migration were removed in #86 (LTV-040)
// before the feature shipped. Every step is idempotent: a second run creates
// nothing.
//
// This module is import-safe for a jsdom/client test (it only TYPE-imports
// Prisma — erased at build — and its data + validation come from the client-safe
// layout-registry). The seed itself (`ensureBuiltInDisplays`) is server/seed-only
// by virtue of taking a live PrismaClient.

/** A built-in Layout definition in the v2 DisplayLayout shape. */
export interface BuiltInLayoutSeed {
  key: string;
  name: string;
  description: string;
  bodyHtml: string;
  defaultCss: string;
  areas: DisplayAreaDefinition[];
}

/** A built-in Template definition in the v2 DisplayTemplate shape. `layoutKey`
 * names the Layout it is built on; the seed resolves it to the seeded row's id. */
export interface BuiltInTemplateSeed {
  key: string;
  name: string;
  layoutKey: string;
  slotContent: DisplaySlotContentMap;
  cssOverrides: string;
  footerHtml: string;
}

/** Deterministic ids for the seeded rows so a first-run create is stable and the
 * device migration is unambiguous. Only used on CREATE (upsert create branch); a
 * pre-existing admin row keyed the same keeps ITS id (the upsert matches on key).
 */
const BUILT_IN_LAYOUT_ID = (key: string) => `builtin-layout-${key}`;
const BUILT_IN_TEMPLATE_ID = (key: string) => `builtin-template-${key}`;

// ---------------------------------------------------------------------------
// everyday-board — board + stacked side rail (chores, rules, gated notice).
// Legacy: header[lodge-header] · main[arrivals-board days:3] · side(stack)
// [chores-board, lodge-rules, notice-board(content:notice)] · footer[info-footer].
// The header/footer are page furniture (fixed LodgeHeader + built-in InfoFooter
// when footerHtml is empty), so only the board + rail live in the body.
// ---------------------------------------------------------------------------

const EVERYDAY_BODY =
  '<div class="eb-grid">' +
  '<div class="eb-board">{{area:board}}</div>' +
  '<div class="eb-rail">{{area:chores}}{{area:rules}}{{area:notice}}</div>' +
  "</div>";

// Re-creates, in the authored-CSS scoped world (every selector is server-prefixed
// with `.display-authored-root`), the legacy `.display-screen:has(
// .display-region-side)` two-column grid, the `.display-region-stack` side rail,
// and the `.display-region-stack .display-notice-board` compact notice card.
// The `[data-display-area]` markers (LTV-041) are the inert wrappers the client
// portals each area into, so the height chain must pass through them.
const EVERYDAY_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.eb-grid {
  display: grid;
  grid-template-columns: 1fr 27vw;
  grid-template-rows: 1fr;
  column-gap: 2.6vmin;
  height: 100%;
  min-height: 0;
}
.eb-board { overflow: hidden; min-width: 0; }
.eb-board > [data-display-area] { display: block; height: 100%; }
.eb-rail {
  display: flex;
  flex-direction: column;
  gap: 1.8vmin;
  overflow: hidden;
}
.eb-rail .display-notice-board {
  height: auto;
  padding: 1.7vmin;
  text-align: left;
  gap: 1.1vmin;
  background: color-mix(in srgb, var(--display-departing) 10%, var(--display-panel));
  border: 1px solid color-mix(in srgb, var(--display-departing) 40%, transparent);
  border-radius: 1.4vmin;
}
.eb-rail .display-notice-kicker { font-size: 1.7vmin; letter-spacing: 0.18em; }
.eb-rail .display-notice-text { font-size: 2vmin; }
`;

const EVERYDAY_LAYOUT: BuiltInLayoutSeed = {
  key: "everyday-board",
  name: "Everyday board",
  description:
    "The daily arrivals board with a stacked side rail (chores, house rules, and a committee notice when one is set).",
  bodyHtml: EVERYDAY_BODY,
  defaultCss: EVERYDAY_CSS,
  areas: [
    { key: "board", description: "The arrivals / bar board.", kind: "static" },
    { key: "chores", description: "Today's chores card.", kind: "static" },
    { key: "rules", description: "House rules card.", kind: "static" },
    {
      key: "notice",
      description: "Committee notice — shown only when a notice is set.",
      kind: "conditional",
      condition: "content:notice",
    },
  ],
};

const EVERYDAY_TEMPLATE: BuiltInTemplateSeed = {
  key: "everyday-board",
  name: "Everyday board",
  layoutKey: "everyday-board",
  slotContent: {
    board: { module: "arrivals-board", options: { days: 3 } },
    chores: { module: "chores-board" },
    rules: { module: "lodge-rules" },
    notice: { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "",
};

// ---------------------------------------------------------------------------
// whole-lodge — a rotator that cycles blockout ⇄ welcome ⇄ gated notice.
// Legacy: main(rotate 8s)[occupancy-grid(occupancy:whole-lodge-in-window),
// welcome, notice-board(content:notice)].
// ---------------------------------------------------------------------------

const WHOLE_LODGE_BODY = '<div class="wl-main">{{area:main}}</div>';

const WHOLE_LODGE_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.wl-main { height: 100%; min-height: 0; overflow: hidden; }
.wl-main > [data-display-area] { display: block; height: 100%; }
`;

const WHOLE_LODGE_LAYOUT: BuiltInLayoutSeed = {
  key: "whole-lodge",
  name: "Whole lodge",
  description:
    "A rotating statement board: the whole-lodge blockout when the lodge is booked out, a welcome panel, and a committee notice when one is set.",
  bodyHtml: WHOLE_LODGE_BODY,
  defaultCss: WHOLE_LODGE_CSS,
  areas: [
    {
      key: "main",
      description: "Rotating whole-lodge statement.",
      kind: "rotator",
      rotateSeconds: 8,
      children: [
        {
          key: "occupancy",
          description: "Whole-lodge blockout — shown while a whole-lodge booking is in the window.",
          condition: "occupancy:whole-lodge-in-window",
        },
        { key: "welcome", description: "Welcome panel." },
        {
          key: "notice",
          description: "Committee notice — shown only when a notice is set.",
          condition: "content:notice",
        },
      ],
    },
  ],
};

const WHOLE_LODGE_TEMPLATE: BuiltInTemplateSeed = {
  key: "whole-lodge",
  name: "Whole lodge",
  layoutKey: "whole-lodge",
  slotContent: {
    "main/occupancy": { module: "occupancy-grid" },
    "main/welcome": { module: "welcome" },
    "main/notice": { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "",
};

// ---------------------------------------------------------------------------
// singles-house — the by-booking singles board, rotating with a gated notice.
// Legacy: main(rotate 8s)[singles-board, notice-board(content:notice)] — the
// singles board shows on its own until a notice is set, then the two rotate.
// ---------------------------------------------------------------------------

const SINGLES_BODY = '<div class="sh-main">{{area:main}}</div>';

const SINGLES_CSS = `
.display-layout-body { height: 100%; min-height: 0; }
.sh-main { height: 100%; min-height: 0; overflow: hidden; }
.sh-main > [data-display-area] { display: block; height: 100%; }
`;

const SINGLES_LAYOUT: BuiltInLayoutSeed = {
  key: "singles-house",
  name: "Singles house",
  description:
    "The by-booking singles board, rotating with a committee notice when one is set.",
  bodyHtml: SINGLES_BODY,
  defaultCss: SINGLES_CSS,
  areas: [
    {
      key: "main",
      description: "Singles board, rotating with any committee notice.",
      kind: "rotator",
      rotateSeconds: 8,
      children: [
        { key: "singles", description: "The by-booking singles board." },
        {
          key: "notice",
          description: "Committee notice — shown only when a notice is set.",
          condition: "content:notice",
        },
      ],
    },
  ],
};

const SINGLES_TEMPLATE: BuiltInTemplateSeed = {
  key: "singles-house",
  name: "Singles house",
  layoutKey: "singles-house",
  slotContent: {
    "main/singles": { module: "singles-board" },
    "main/notice": { module: "notice-board" },
  },
  cssOverrides: "",
  footerHtml: "",
};

/** The three built-in Layouts, in seed order (a Template's Layout must exist
 * first). */
export const BUILT_IN_DISPLAY_LAYOUTS: BuiltInLayoutSeed[] = [
  EVERYDAY_LAYOUT,
  WHOLE_LODGE_LAYOUT,
  SINGLES_LAYOUT,
];

/** The three built-in Templates, one per Layout, keyed identically to the legacy
 * code built-ins (the registry keys `resolveDisplayTemplate` still resolves). */
export const BUILT_IN_DISPLAY_TEMPLATES: BuiltInTemplateSeed[] = [
  EVERYDAY_TEMPLATE,
  WHOLE_LODGE_TEMPLATE,
  SINGLES_TEMPLATE,
];

// Validate every built-in at module load: a broken seed is a programming error
// and must fail fast in tests/build, never at serve time on a lobby wall. This
// runs the SAME structural contract the authoring routes and the state route's
// assembler apply (validateDisplayLayoutDefinition / validateDisplaySlotContent).
for (const layout of BUILT_IN_DISPLAY_LAYOUTS) {
  const areas = validateDisplayLayoutDefinition(layout.bodyHtml, layout.areas);
  const template = BUILT_IN_DISPLAY_TEMPLATES.find(
    (candidate) => candidate.layoutKey === layout.key
  );
  if (!template) {
    throw new Error(`Built-in layout "${layout.key}" has no matching template`);
  }
  validateDisplaySlotContent(areas, template.slotContent);
}

/**
 * The subset of the Prisma client `ensureBuiltInDisplays` touches. Typed against
 * the generated Prisma arg types so the real client satisfies it and a test can
 * pass a narrow mock (cast via `as unknown as EnsureBuiltInDisplaysClient`).
 */
export interface EnsureBuiltInDisplaysClient {
  displayLayout: {
    upsert: (args: Prisma.DisplayLayoutUpsertArgs) => Promise<{ id: string }>;
  };
  displayTemplate: {
    upsert: (args: Prisma.DisplayTemplateUpsertArgs) => Promise<{ id: string }>;
  };
}

/**
 * Seed the three built-in Layouts + Templates create-if-missing (LTV-038).
 * Idempotent and admin-safe: Layouts/Templates upsert by `key` with an EMPTY
 * update, so an admin who customised a built-in keeps their version
 * (create-if-missing). Devices bind to these seeded rows by `templateId`; the
 * legacy device `templateKey` column and its one-shot migration were removed in
 * #86 (LTV-040), before the feature shipped.
 */
export async function ensureBuiltInDisplays(
  prisma: EnsureBuiltInDisplaysClient
): Promise<void> {
  for (const layout of BUILT_IN_DISPLAY_LAYOUTS) {
    await prisma.displayLayout.upsert({
      where: { key: layout.key },
      update: {},
      create: {
        id: BUILT_IN_LAYOUT_ID(layout.key),
        key: layout.key,
        name: layout.name,
        description: layout.description,
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  }

  for (const template of BUILT_IN_DISPLAY_TEMPLATES) {
    // The Template binds its Layout by id. The Layout was just upserted; resolve
    // its id by re-upserting is wasteful, so use the deterministic create id —
    // which is the id a FRESH seed created, and is stable across re-runs. When an
    // admin pre-created a layout with this key, its id differs, but a matching
    // pre-created template would already bind it, and the empty-update upsert
    // leaves that admin row untouched.
    await prisma.displayTemplate.upsert({
      where: { key: template.key },
      update: {},
      create: {
        id: BUILT_IN_TEMPLATE_ID(template.key),
        key: template.key,
        name: template.name,
        layoutId: BUILT_IN_LAYOUT_ID(template.layoutKey),
        slotContent: template.slotContent as unknown as Prisma.InputJsonValue,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      },
      select: { id: true },
    });
  }
}
