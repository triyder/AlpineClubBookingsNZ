import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";

vi.mock("server-only", () => ({}));

import { readBundle } from "@/lib/config-transfer/bundle";
import {
  validateLayoutForSave,
  validateTemplateForSave,
} from "@/lib/lodge-display/authoring-validation";

// Issue #2047 — the committed "display-template-pack extras" bundle
// (docs/lobby-display/seeds/) must be a genuine, installable config-transfer
// artifact: its manifest checksums are real (readBundle raises no integrity
// warning), and every layout/template inside passes the SAME save contract the
// authoring UIs and the importer enforce (ADR-003 §5 "Unattended surface"), so
// the bundle can never install a structurally broken display.

const ZIP_PATH = path.join(
  process.cwd(),
  "docs/lobby-display/seeds/display-template-pack.bundle.zip"
);

interface BundleLayout {
  key: string;
  bodyHtml: string;
  defaultCss: string;
  areas: unknown;
}
interface BundleTemplate {
  key: string;
  layoutKey: string;
  slotContent: unknown;
  cssOverrides: string;
  footerHtml: string;
}

function loadBundle(): {
  bytes: Uint8Array;
  layouts: BundleLayout[];
  templates: BundleTemplate[];
} {
  const bytes = readFileSync(ZIP_PATH);
  const files = unzipSync(bytes);
  const layouts = JSON.parse(strFromU8(files["display/layouts.json"])) as BundleLayout[];
  const templates = JSON.parse(
    strFromU8(files["display/templates.json"])
  ) as BundleTemplate[];
  return { bytes, layouts, templates };
}

describe("display-template-pack extras bundle", () => {
  it("reads through readBundle with genuine checksums (no integrity warnings)", () => {
    const { bytes } = loadBundle();
    const result = readBundle(bytes);
    expect(result.warnings).toEqual([]);
    expect(result.manifest.includedCategories).toContain("lodge-config");
    // The two extras layouts + templates travel as lodge-config display files.
    const paths = result.manifest.files.map((f) => f.path);
    expect(paths).toContain("display/layouts.json");
    expect(paths).toContain("display/templates.json");
  });

  it("ships the two situational extras keyed stably", () => {
    const { layouts, templates } = loadBundle();
    expect(layouts.map((l) => l.key).sort()).toEqual(["arrivals-strip", "busy-weekend"]);
    expect(templates.map((t) => t.key).sort()).toEqual(["arrivals-strip", "busy-weekend"]);
  });

  it("validates every extras layout + template through the save contract", () => {
    const { layouts, templates } = loadBundle();
    const layoutByKey = new Map(layouts.map((l) => [l.key, l]));

    for (const layout of layouts) {
      const verdict = validateLayoutForSave({
        bodyHtml: layout.bodyHtml,
        defaultCss: layout.defaultCss,
        areas: layout.areas,
      });
      expect(verdict.ok, `layout "${layout.key}": ${JSON.stringify(verdict)}`).toBe(true);
      // Benign, hand-authored CSS/HTML — nothing the sanitiser neutralises.
      expect(verdict.warnings).toEqual([]);
    }

    for (const template of templates) {
      const layout = layoutByKey.get(template.layoutKey);
      expect(layout, `template "${template.key}" binds a bundled layout`).toBeDefined();
      const verdict = validateTemplateForSave({
        layout: { bodyHtml: layout!.bodyHtml, areas: layout!.areas },
        slotContent: template.slotContent,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      });
      expect(verdict.ok, `template "${template.key}": ${JSON.stringify(verdict)}`).toBe(
        true
      );
      expect(verdict.warnings).toEqual([]);
    }
  });
});
