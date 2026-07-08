import { describe, expect, it } from "vitest";

import { rawHasValue, updateDataForMode } from "@/lib/config-transfer/import-types";

// Merge vs overwrite semantics for how an import writes fields onto an existing
// row. Merge keeps the target's value for blank/omitted bundle fields; overwrite
// writes everything. Creates are unaffected (they always use the full data).

describe("config-transfer import merge mode", () => {
  it("rawHasValue treats blank/absent as no-value but false/0 as values", () => {
    expect(rawHasValue({ x: "hello" }, "x")).toBe(true);
    expect(rawHasValue({ x: "  " }, "x")).toBe(false); // whitespace only
    expect(rawHasValue({ x: "" }, "x")).toBe(false);
    expect(rawHasValue({}, "x")).toBe(false); // absent
    expect(rawHasValue({ x: false }, "x")).toBe(true); // boolean false is a value
    expect(rawHasValue({ x: 0 }, "x")).toBe(true); // 0 is a value
    expect(rawHasValue({ x: null }, "x")).toBe(false);
  });

  it("overwrite mode writes every field verbatim (blanks clear)", () => {
    const raw = { name: "New", notes: "" };
    const data = { name: "New", notes: null };
    expect(updateDataForMode("overwrite", raw, data)).toEqual({ name: "New", notes: null });
  });

  it("merge mode drops fields whose bundle source is blank/absent (keep existing)", () => {
    const raw = { name: "New", notes: "", active: false };
    const data = { name: "New", notes: null, active: false };
    // notes is blank in the bundle → omitted so the target keeps its value;
    // name and the boolean active are real values → written.
    expect(updateDataForMode("merge", raw, data)).toEqual({ name: "New", active: false });
  });

  it("merge mode with an all-blank row yields an empty (no-op) update", () => {
    const raw = { a: "", b: "   " };
    const data = { a: null, b: null };
    expect(updateDataForMode("merge", raw, data)).toEqual({});
  });
});
