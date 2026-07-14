import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const helperWriters: Array<[string, number]> = [
  ["src/app/api/admin/age-tier-settings/route.ts", 1],
  ["src/app/api/admin/lodges/route.ts", 1],
  ["src/app/api/admin/lodges/[id]/route.ts", 1],
  ["src/app/api/admin/page-content/route.ts", 3],
  ["src/app/api/admin/config-transfer/apply/route.ts", 1],
  ["src/app/api/admin/seasons/route.ts", 1],
  ["src/app/api/admin/seasons/[id]/route.ts", 2],
  ["src/app/api/admin/booking-policies/cancellation/route.ts", 1],
  ["src/app/api/admin/booking-policies/group-discount/route.ts", 1],
  ["src/app/api/admin/booking-policies/minimum-stay/route.ts", 1],
  ["src/app/api/admin/booking-policies/minimum-stay/[id]/route.ts", 2],
  ["src/app/api/admin/booking-policies/periods/route.ts", 1],
  ["src/app/api/admin/booking-policies/periods/[id]/route.ts", 2],
];
const directWriters = [
  "src/app/api/admin/fee-configuration/route.ts",
  "src/app/api/admin/membership-types/route.ts",
  "src/app/api/admin/membership-types/[id]/route.ts",
  "src/app/api/admin/membership-types/[id]/merge/route.ts",
  "src/app/api/admin/membership-types/reorder/route.ts",
  "src/app/api/admin/public-content-settings/route.ts",
];

describe("public content authority invalidation contract", () => {
  it.each(helperWriters)("invalidates after successful writes in %s", (relativePath, expectedCalls) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    expect(source.match(/^\s*revalidatePublicPageContent\(\);?$/gm)?.length ?? 0).toBe(expectedCalls);
  });

  it.each(directWriters)("invalidates the public layout in %s", (relativePath) => {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    expect(source).toContain('revalidatePath("/", "layout")');
  });

  it("keeps config-transfer invalidation on the success path after its audited apply", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/app/api/admin/config-transfer/apply/route.ts"), "utf8");
    expect(source.indexOf("revalidatePublicPageContent()"))
      .toBeGreaterThan(source.indexOf("await applyConfigImport"));
    expect(source.indexOf("revalidatePublicPageContent()"))
      .toBeLessThan(source.indexOf("return NextResponse.json({ result })"));
  });
});
