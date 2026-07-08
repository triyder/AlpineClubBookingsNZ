import { describe, expect, it, vi } from "vitest";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";

vi.mock("server-only", () => ({}));

import {
  buildBundle,
  readBundle,
  sha256Hex,
  ConfigTransferBundleError,
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
    sourceXeroTenantId: null,
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
    const { manifest, files } = readBundle(zip);

    expect(manifest.formatVersion).toBe(1);
    expect(manifest.generatedAt).toBe(GENERATED_AT);
    expect(manifest.includedCategories).toEqual([
      "site-content",
      "club-settings",
    ]);
    expect(manifest.doorCodesIncluded).toBe(false);
    expect(files.get("site-content/pages.csv")).toBeDefined();
    expect(strFromU8(files.get("club-settings/modules.json")!)).toContain(
      "bedAllocation",
    );
    // Declared checksum matches the actual bytes.
    const pages = manifest.files.find((f) => f.path === "site-content/pages.csv");
    expect(pages?.sha256).toBe(sha256Hex(files.get("site-content/pages.csv")!));
  });

  it("rejects a tampered file (checksum mismatch)", () => {
    const zip = build();
    const unzipped = unzipSync(zip);
    unzipped["site-content/pages.csv"] = strToU8("slug,title\nhacked,Hacked\n");
    const tampered = zipSync(unzipped); // manifest checksum now stale
    expect(() => readBundle(tampered)).toThrow(ConfigTransferBundleError);
    expect(() => readBundle(tampered)).toThrow(/checksum mismatch/i);
  });

  it("rejects a bundle with an undeclared extra file", () => {
    const zip = build();
    const unzipped = unzipSync(zip);
    unzipped["stowaway.txt"] = strToU8("surprise");
    const extra = zipSync(unzipped);
    expect(() => readBundle(extra)).toThrow(/undeclared file/i);
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
      sourceXeroTenantId: null,
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
    expect(() => readBundle(strToU8("not a zip"))).toThrow(
      /not a valid zip/i,
    );
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

  it("records the source Xero tenant id and door-code opt-in in the manifest", () => {
    const zip = buildBundle({
      entries: sampleEntries(),
      appVersion: "0.10.1",
      prismaMigration: null,
      sourceXeroTenantId: "tenant-abc",
      includedCategories: ["site-content", "club-settings"],
      doorCodesIncluded: true,
      generatedAt: GENERATED_AT,
    });
    const manifest = manifestOf(zip);
    expect(manifest.sourceXeroTenantId).toBe("tenant-abc");
    expect(manifest.doorCodesIncluded).toBe(true);
  });
});
