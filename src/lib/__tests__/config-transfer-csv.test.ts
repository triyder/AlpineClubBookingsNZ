import { describe, expect, it } from "vitest";

import { serialiseCsv, parseCsv, CsvParseError } from "@/lib/config-transfer/csv";

describe("config-transfer CSV codec", () => {
  it("round-trips ordinary rows", () => {
    const csv = serialiseCsv(
      ["slug", "title", "published"],
      [
        { slug: "about", title: "About", published: true },
        { slug: "faq", title: "FAQ", published: false },
      ],
    );
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual(["slug", "title", "published"]);
    expect(rows).toEqual([
      { slug: "about", title: "About", published: "true" },
      { slug: "faq", title: "FAQ", published: "false" },
    ]);
  });

  it("quotes and recovers commas, quotes, and newlines", () => {
    const tricky = 'Line one, with comma\nLine "two"';
    const csv = serialiseCsv(["key", "value"], [{ key: "k", value: tricky }]);
    const { rows } = parseCsv(csv);
    expect(rows[0].value).toBe(tricky);
  });

  it("renders null/undefined as empty and coerces numbers", () => {
    const csv = serialiseCsv(
      ["a", "b", "c"],
      [{ a: null, b: undefined, c: 42 }],
    );
    const { rows } = parseCsv(csv);
    expect(rows[0]).toEqual({ a: "", b: "", c: "42" });
  });

  it("is tolerant of CRLF line endings on read", () => {
    const { rows } = parseCsv("slug,title\r\nabout,About\r\n");
    expect(rows).toEqual([{ slug: "about", title: "About" }]);
  });

  it("throws on an unterminated quoted field", () => {
    expect(() => parseCsv('a,b\n"unterminated,x\n')).toThrow(CsvParseError);
  });

  it("returns empty for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});
