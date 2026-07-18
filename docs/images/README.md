# Documentation images

All documentation screenshots live here, grouped by area:

- `admin/` — admin/operator UI captures (`admin-<page>.png`).
- `public/` — public-facing captures (`public-<page>.png`).

These are produced by the automated capture harness, never hand-cropped ad hoc,
so they stay consistent and re-creatable:

```bash
npm run test:e2e:prepare        # boot + seed the staging stack (docs/E2E_PLAYWRIGHT.md)
npm run docs:screenshots        # capture the named set into this tree
npm run docs:screenshots -- --list   # dry run: print the manifest, no browser
```

Filenames are stable and defined in the harness manifest
(`e2e/tools/capture-screenshots.ts`), so a refresh overwrites in place — a
screenshot update is a diff, not a rename. Viewport is a fixed 1280×800.

See [`../STYLE_GUIDE.md`](../STYLE_GUIDE.md) → "Screenshot conventions" for
naming, alt-text, refresh policy, and the privacy rule (only ever capture the
demo/seeded data set — never real member, payment, or accounting data).
