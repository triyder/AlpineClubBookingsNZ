import { describe, expect, it, vi } from "vitest";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import {
  buildBundle,
  readBundle,
  resealBundle,
  sha256Hex,
  type BundleEntry,
} from "@/lib/config-transfer/bundle";
import {
  CONFIG_TRANSFER_MANIFEST_PATH,
  type ConfigTransferManifest,
} from "@/lib/config-transfer/manifest";

const GENERATED_AT = "2026-07-08T00:00:00.000Z";

function sampleEntries(): BundleEntry[] {
  return [
    {
      path: "site-content/pages.csv",
      category: "site-content",
      rowCount: 2,
      bytes: strToU8("slug,title\nabout,About\nfaq,FAQ\n"),
    },
    {
      path: "club-settings/modules.json",
      category: "club-settings",
      rowCount: 1,
      bytes: strToU8(JSON.stringify({ bedAllocation: true })),
    },
  ];
}

function build(entries = sampleEntries()) {
  return buildBundle({
    entries,
    appVersion: "0.10.1",
    prismaMigration: "20260708230000_add_member_credit_note_allocation",
    includedCategories: ["site-content", "club-settings"],
    doorCodesIncluded: false,
    generatedAt: GENERATED_AT,
  });
}

function manifestOf(zip: Uint8Array): ConfigTransferManifest {
  return JSON.parse(
    strFromU8(unzipSync(zip)[CONFIG_TRANSFER_MANIFEST_PATH]),
  ) as ConfigTransferManifest;
}

describe("config-transfer bundle codec", () => {
  it("round-trips entries and stamps a valid manifest with checksums", () => {
    const zip = build();
    const { manifest, files, warnings } = readBundle(zip);

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.generatedAt).toBe(GENERATED_AT);
    expect(manifest.includedCategories).toEqual([
      "site-content",
      "club-settings",
    ]);
    expect(manifest.doorCodesIncluded).toBe(false);
    expect(warnings).toEqual([]);
    expect(files.get("site-content/pages.csv")).toBeDefined();
    expect(strFromU8(files.get("club-settings/modules.json")!)).toContain(
      "bedAllocation",
    );
    // Declared checksum matches the actual bytes.
    const pages = manifest.files.find((f) => f.path === "site-content/pages.csv");
    expect(pages?.sha256).toBe(sha256Hex(files.get("site-content/pages.csv")!));
  });

  it("WARNS (does not reject) on a hand-edited file whose checksum drifted", () => {
    const zip = build();
    const unzipped = unzipSync(zip);
    unzipped["site-content/pages.csv"] = strToU8("slug,title\nedited,Edited\n");
    const edited = zipSync(unzipped); // manifest checksum now stale
    const { files, warnings } = readBundle(edited);
    // Bundle is still usable (files-first) and the edit is surfaced, not blocked.
    expect(strFromU8(files.get("site-content/pages.csv")!)).toContain("Edited");
    expect(warnings.some((w) => /site-content\/pages\.csv/.test(w) && /checksum|edited/i.test(w))).toBe(true);
  });

  it("WARNS (does not reject) on a present-but-undeclared file", () => {
    const zip = build();
    const unzipped = unzipSync(zip);
    unzipped["site-content/extra.csv"] = strToU8("added\n");
    const extra = zipSync(unzipped);
    const { files, warnings } = readBundle(extra);
    expect(files.get("site-content/extra.csv")).toBeDefined();
    expect(warnings.some((w) => /not listed in the manifest/i.test(w))).toBe(true);
  });

  it("rejects an unsafe entry path (path traversal)", () => {
    const zip = build();
    const unzipped = unzipSync(zip);
    unzipped["../escape.txt"] = strToU8("no");
    const unsafe = zipSync(unzipped);
    expect(() => readBundle(unsafe)).toThrow(/unsafe entry path/i);
  });

  it("rejects a bundle missing the manifest", () => {
    const bare = zipSync({ "site-content/pages.csv": strToU8("slug\nabout\n") });
    expect(() => readBundle(bare)).toThrow(/missing manifest/i);
  });

  it("refuses a newer format version than this app supports", () => {
    const manifest = {
      formatVersion: 999,
      generatedAt: GENERATED_AT,
      app: { version: "9.9.9", prismaMigration: null },
      includedCategories: [],
      files: [],
      doorCodesIncluded: false,
    };
    const zip = zipSync({
      [CONFIG_TRANSFER_MANIFEST_PATH]: strToU8(JSON.stringify(manifest)),
    });
    expect(() => readBundle(zip)).toThrow(/newer than this app/i);
  });

  it("rejects invalid zip bytes", () => {
    expect(() => readBundle(strToU8("not a zip"))).toThrow(/not a valid zip/i);
  });

  it("refuses to build an entry that collides with the manifest path", () => {
    expect(() =>
      build([
        {
          path: CONFIG_TRANSFER_MANIFEST_PATH,
          category: "site-content",
          rowCount: 0,
          bytes: strToU8("x"),
        },
      ]),
    ).toThrow(/collides with the manifest/i);
  });

  it("records the door-code opt-in in the manifest", () => {
    const zip = buildBundle({
      entries: sampleEntries(),
      appVersion: "0.10.1",
      prismaMigration: null,
      includedCategories: ["site-content", "club-settings"],
      doorCodesIncluded: true,
      generatedAt: GENERATED_AT,
    });
    const manifest = manifestOf(zip);
    expect(manifest.doorCodesIncluded).toBe(true);
    // The manifest no longer carries a source Xero tenant id.
    expect("sourceXeroTenantId" in manifest).toBe(false);
  });

  it("tolerates a single wrapper folder + macOS junk (re-zip mistake)", () => {
    const zip = build();
    const unzipped = unzipSync(zip);
    // Simulate macOS "Compress the folder": everything nested under one dir,
    // plus __MACOSX/ and .DS_Store cruft.
    const wrapped: Record<string, Uint8Array> = {
      ".DS_Store": strToU8("junk"),
      "__MACOSX/._top": strToU8("junk"),
    };
    for (const [name, bytes] of Object.entries(unzipped)) {
      wrapped[`config-transfer-2026-07-09/${name}`] = bytes;
      wrapped[`__MACOSX/config-transfer-2026-07-09/._${name}`] = strToU8("junk");
    }
    const { manifest, files, warnings } = readBundle(zipSync(wrapped));
    expect(manifest.formatVersion).toBe(1); // manifest found after prefix strip
    expect(files.get("site-content/pages.csv")).toBeDefined();
    expect([...files.keys()].some((k) => k.startsWith("__MACOSX") || k.includes(".DS_Store"))).toBe(false);
    expect(warnings).toEqual([]); // stripped cleanly → checksums still match
  });

  it("ignores explicit directory entries a re-zip adds (no spurious warnings)", () => {
    const zip = build();
    const withDirs: Record<string, Uint8Array> = {
      ...unzipSync(zip),
      "site-content/": new Uint8Array(0),
      "club-settings/": new Uint8Array(0),
    };
    const { files, warnings } = readBundle(zipSync(withDirs));
    expect(files.has("site-content/")).toBe(false);
    expect(files.has("club-settings/")).toBe(false);
    // Directory markers are not files, so they must not warn as "undeclared".
    expect(warnings).toEqual([]);
  });

  it("reseal regenerates the manifest so an edited bundle validates clean", () => {
    const zip = build();
    const unzipped = unzipSync(zip);
    unzipped["site-content/pages.csv"] = strToU8("slug,title\nedited,Edited\n");
    const edited = zipSync(unzipped);
    expect(readBundle(edited).warnings.length).toBeGreaterThan(0);

    const resealed = resealBundle(edited);
    const { warnings, files } = readBundle(resealed);
    expect(warnings).toEqual([]);
    expect(strFromU8(files.get("site-content/pages.csv")!)).toContain("Edited");
  });
});
