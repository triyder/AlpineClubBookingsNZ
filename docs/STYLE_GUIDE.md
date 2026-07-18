# Documentation Style Guide

This guide defines how documentation is written and organised in this
repository. It is the foundation the operator-guide programme (issue #2050)
builds on: every new guide follows the skeleton and conventions below so the
docs read as one coherent, best-in-class set rather than a pile of pages.

`AGENTS.md` ("Change Discipline" → docs lockstep) makes following this guide a
requirement whenever documentation is added or changed. Read it here first.

## Audience labels

Every document targets one or more of four audiences. State the audience near
the top of the page (a short "Audience:" line, or make it obvious from a hub
section heading). The four labels are:

| Label | Who they are | What they need |
| --- | --- | --- |
| **Adopter** | Someone evaluating or forking the platform for their own club. | Product scope, setup, configuration, what to change for their club, deployment. |
| **Operator** | An admin/committee member running a live club day to day. | Task-focused "how do I do X" guides with screenshots, settings references, troubleshooting. |
| **Developer** | Someone changing the code. | Architecture, module boundaries, domain invariants, state machines, test/CI contracts. |
| **Agent** | An automated coding agent (Claude Code, Codex). | The agent contract, workflow, review severity, prompt-injection handling. |

A page may serve more than one audience (for example `ARCHITECTURE.md` serves
developers and adopters). List every audience it genuinely serves; do not
label a deep-internals doc "operator" to look approachable.

## Plain-English first, WITH technical detail — never either/or

Lead every section with a plain-English sentence a non-technical operator can
follow, THEN give the precise technical detail (file paths, env vars, exact
flag names, `code`) alongside it. This is not a choice between two versions of
a doc; both live in the same paragraph or in adjacent plain-then-precise
sentences. An operator should be able to act from the plain text; a developer
should find the exact contract in the same place without opening the code.

- Good: "Turn on the waitlist so members can queue for full nights (Admin →
  Setup → Modules, the `waitlist` module). It gates `/admin/waitlist` and the
  force-confirm actions."
- Avoid: a plain paragraph that never names the toggle, or a wall of
  `snake_case` with no sentence explaining what it does for the club.

Keep money in integer cents and dates as NZ date-only lodge nights in every
example, matching the domain rules in `DOMAIN_INVARIANTS.md`.

## Where operator guides live (pinned)

All operator guides live in **`docs/guides/`**, one Markdown file per admin
area, named after the route (`docs/guides/bookings.md` for `/admin/bookings`,
`docs/guides/bed-allocation.md` for `/admin/bed-allocation`). This is fixed so
every relative path in a guide is predictable:

- Screenshots (under `docs/images/**`) are referenced as `../images/<area>/…`.
- The hub back-link (to `docs/README.md`) is `../README.md`.
- A feature-hub back-link (e.g. to `docs/multi-lodge/README.md`) is
  `../multi-lodge/README.md`.

The copy-paste template below already uses these paths; keep new guides in
`docs/guides/` so they stay correct. `COVERAGE_MATRIX.md` names the same
location, and #2050 agents must place guides there.

## Operator-guide page skeleton (required)

Every operator guide (the pages #2050 produces, one per admin area, under
`docs/guides/`) uses this exact section order. Omit a section only when it
genuinely does not apply, and say so rather than silently dropping it.

1. **What it is** — one or two plain sentences: what this feature/area does for
   the club, and the admin path to reach it (`Admin → …`) plus the route
   (`/admin/<area>`).
2. **When you'd use it** — the real situations that send an operator here.
3. **Step-by-step** — numbered tasks, each with the click path and an inline
   **screenshot** (see conventions below) at the step that needs it.
4. **Settings reference** — a table of every setting/field on the page: name,
   what it controls in plain English, default, and any constraint (e.g. "integer
   cents", "NZ date-only", "requires the `xeroIntegration` module").
5. **Troubleshooting** — symptom → cause → fix, for the failure modes operators
   actually hit. Link to the relevant runbook when recovery is involved.
6. **Related links** — back-link to the hub (`docs/README.md` and/or a feature
   hub), plus sibling guides and the reference/architecture docs that own the
   deeper contract.

A copy-paste template is at the end of this file.

## Screenshot conventions

Screenshots keep operator guides usable. They are produced by the automated
capture harness, never hand-cropped ad hoc, so they stay consistent and
re-creatable.

- **Location:** all images live under `docs/images/**`, grouped by area
  (`docs/images/admin/`, `docs/images/public/`). Never store screenshots
  elsewhere or inline them as data URIs.
- **Harness:** `e2e/tools/capture-screenshots.ts` (run via `npm run
  docs:screenshots`) captures a **named** set against the seeded staging app.
  Filenames are stable and defined in the harness manifest, so re-running
  overwrites the same file — a screenshot refresh is a diff, not a rename.
- **Naming:** `<area>-<page-or-state>.png`, lower-kebab-case, matching the
  harness manifest key (e.g. `admin-dashboard.png`, `admin-bed-allocation.png`,
  `public-home.png`). Do not add spaces, capitals, or timestamps.
- **Viewport / determinism:** the harness uses a fixed 1280×800 desktop
  viewport and the deterministic demo seed so captures are stable across runs.
  Capture full-page where the page scrolls.
- **Size:** prefer PNG; keep individual images reasonable (the 1280-wide
  full-page PNGs the harness emits are fine). Do not commit multi-megabyte
  raw captures.
- **Alt text (required):** every embedded image has descriptive alt text that
  states what the screenshot shows, e.g. from a guide in `docs/guides/`:
  `![Admin dashboard showing the Needs Attention cards](../images/admin/admin-dashboard.png)`.
  Alt text is not decorative filler — a screen-reader user must learn what the
  image conveys.
- **Ordering (link check):** a screenshot must be captured and committed *before
  or in the same change as* the guide that references it — the CI link check
  (lychee, offline) fails on a guide that points at an image file that does not
  yet exist on disk. Never merge a guide ahead of its images.
- **Refresh policy:** when a page's UI changes materially, re-run the harness in
  the same PR and commit the updated image (same filename). Treat a stale
  screenshot like stale prose: fix it in lockstep. If the harness gains a new
  named page, add its manifest entry and reference it from the guide in the same
  change.
- **Privacy:** capture only against the demo/seeded data set. Never commit a
  screenshot containing real member, payment, or accounting data
  (`CONTRIBUTING.md`).

## Linking rules

The docs form a navigable graph, not a flat folder. Two invariants:

1. **Every doc is reachable from a hub.** A new doc must be linked from
   `docs/README.md` (the top audience-first hub) directly, or from a feature hub
   (a `README.md` inside a feature subdirectory such as `finance-dashboard/`,
   `multi-lodge/`, `lobby-display/`, `xero/`) that is itself linked from
   `docs/README.md`. No orphan pages.
2. **Every hub back-links.** A feature hub links back up to `docs/README.md` (a
   short "Part of the [documentation hub](../README.md)" line), and every
   operator guide's "Related links" points back to its hub. Navigation works in
   both directions.

Other linking rules:

- Use **relative** links between docs (`../DEPLOYMENT.md`, `xero/ARCHITECTURE.md`),
  never absolute file paths or bare filenames that hide which directory the
  target lives in. A file at the repo root referenced from `docs/` is
  `../NAME.md`.
- Prefer linking a `[`code-named`](path)` reference over a bare code span when
  you name another doc, so the link checker can verify it.
- Run `npm run docs:linkcheck` before pushing; CI runs the same class of check
  (`.github/workflows/docs-link-check.yml`, lychee in offline mode).

## Mermaid conventions

Diagrams are authored in [Mermaid](https://mermaid.js.org/) fenced code blocks
(` ```mermaid `) so they render on GitHub and stay diff-able in text. They are
hand-curated to reflect the real code — never machine-generated from an import
scan, which produces noise instead of the meaningful module boundaries a reader
needs (owner decision, #2049).

- Use `flowchart TD`/`LR` for structure and dependency/module-boundary
  diagrams, `sequenceDiagram` for request/data flows, and `erDiagram` only for
  small focused data slices (the full schema stays in `prisma/schema.prisma`).
- Keep each diagram to one idea. Prefer several small diagrams over one giant
  one.
- Label edges with the relationship ("queues", "reads", "webhook") rather than
  leaving bare arrows.
- Quote node labels containing spaces or punctuation (`A["Next.js app"]`) so the
  parser does not choke.
- Verify a diagram parses before committing: `npx @mermaid-js/mermaid-cli -i
  file.md -o /tmp/out.svg` (or paste into the mermaid live editor). Note in the
  PR how you validated.
- A diagram must match the code. When the code moves, update the diagram in the
  same PR — the same lockstep rule as screenshots.

## Copy-paste operator-guide template

```markdown
# <Feature / Area Name>

Audience: Operator

## What it is

<Plain sentence: what this does for the club.> Find it at **Admin → <menu path>**
(`/admin/<route>`).

## When you'd use it

- <Situation that sends an operator here.>
- <Another situation.>

## Step-by-step

### <Task name>

1. Go to **Admin → <path>**.
2. <Action.>

   ![<Descriptive alt text>](../images/admin/<area>-<state>.png)

3. <Action, with the exact field/button named.>

## Settings reference

| Setting | What it controls | Default | Notes / constraints |
| --- | --- | --- | --- |
| <Field> | <Plain-English effect> | <default> | <e.g. integer cents, requires `<module>`> |

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| <What the operator sees> | <Why> | <What to do; link a runbook if recovery is involved> |

## Related links

- Back to the [documentation hub](../README.md).
- Feature hub: [<hub>](<path>) <!-- if this guide belongs to one -->
- Reference: [<architecture/runbook doc>](<path>)
```
