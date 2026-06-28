import { describe, expect, it } from "vitest";
import {
  buildEditableStructuredValues,
  flattenPageFields,
  getPageContentSchema,
  listPageContentSchemaPaths,
  pickRows,
  pickText,
  toStructuredContentValues,
  type PageContentSchema,
  type RowsFieldSpec,
  type ScalarFieldSpec,
} from "@/lib/page-content-schema";

const scalar: ScalarFieldSpec = {
  kind: "scalar",
  key: "x",
  label: "X",
  type: "text",
  maxLength: 50,
  default: "DEFAULT",
};

const rowsSpec: RowsFieldSpec = {
  kind: "rows",
  key: "r",
  label: "R",
  maxRows: 5,
  columns: [
    { key: "a", label: "A", type: "text", maxLength: 20 },
    { key: "b", label: "B", type: "text", maxLength: 20 },
  ],
  default: [{ a: "da", b: "db" }],
};

describe("pickText", () => {
  it("returns the stored, trimmed value when present", () => {
    expect(pickText({ x: "  hello " }, scalar)).toBe("hello");
  });

  it("falls back to the default when missing, empty, whitespace or non-string", () => {
    expect(pickText({}, scalar)).toBe("DEFAULT");
    expect(pickText(undefined, scalar)).toBe("DEFAULT");
    expect(pickText({ x: "" }, scalar)).toBe("DEFAULT");
    expect(pickText({ x: "   " }, scalar)).toBe("DEFAULT");
    // Defensive: a non-string value should not be returned as text.
    expect(pickText({ x: 5 as unknown as string }, scalar)).toBe("DEFAULT");
  });
});

describe("pickRows", () => {
  it("returns stored rows mapped to the known columns", () => {
    expect(pickRows({ r: [{ a: " x ", b: "y" }] }, rowsSpec)).toEqual([
      { a: "x", b: "y" },
    ]);
  });

  it("drops unknown columns and fills missing ones with empty strings", () => {
    expect(
      pickRows({ r: [{ a: "x", c: "ignore" } as Record<string, string>] }, rowsSpec),
    ).toEqual([{ a: "x", b: "" }]);
  });

  it("drops fully-empty rows but keeps rows with any non-empty cell", () => {
    expect(
      pickRows(
        { r: [{ a: "", b: "" }, { a: "", b: "z" }] },
        rowsSpec,
      ),
    ).toEqual([{ a: "", b: "z" }]);
  });

  it("falls back to the default for missing, empty or all-empty arrays", () => {
    expect(pickRows({}, rowsSpec)).toEqual([{ a: "da", b: "db" }]);
    expect(pickRows({ r: [] }, rowsSpec)).toEqual([{ a: "da", b: "db" }]);
    expect(pickRows({ r: [{ a: "", b: "" }] }, rowsSpec)).toEqual([
      { a: "da", b: "db" },
    ]);
  });
});

describe("toStructuredContentValues", () => {
  it("keeps strings and arrays of string-keyed rows, dropping everything else", () => {
    expect(
      toStructuredContentValues({
        a: "s",
        b: [{ x: "1" }],
        n: 5,
        arr: [1, 2],
        bad: [{ x: 1, y: "2" }],
      }),
    ).toEqual({
      a: "s",
      b: [{ x: "1" }],
      arr: [],
      bad: [{ y: "2" }],
    });
  });

  it("returns {} for non-object input", () => {
    expect(toStructuredContentValues(null)).toEqual({});
    expect(toStructuredContentValues("str")).toEqual({});
    expect(toStructuredContentValues([1, 2])).toEqual({});
  });
});

describe("flattenPageFields", () => {
  it("flattens all sections into a key -> spec lookup", () => {
    const schema: PageContentSchema = {
      path: "/x",
      label: "X",
      sections: [
        { title: "One", fields: [scalar] },
        { title: "Two", fields: [rowsSpec] },
      ],
    };
    const fields = flattenPageFields(schema);
    expect(Object.keys(fields).sort()).toEqual(["r", "x"]);
    expect(fields.x).toBe(scalar);
    expect(fields.r).toBe(rowsSpec);
  });
});

describe("buildEditableStructuredValues", () => {
  const schema: PageContentSchema = {
    path: "/x",
    label: "X",
    sections: [{ title: "One", fields: [scalar, rowsSpec] }],
  };

  it("pre-fills defaults when nothing is stored", () => {
    expect(buildEditableStructuredValues(schema, undefined)).toEqual({
      x: "DEFAULT",
      r: [{ a: "da", b: "db" }],
    });
  });

  it("overlays stored values over the defaults", () => {
    expect(
      buildEditableStructuredValues(schema, { x: "stored" }),
    ).toEqual({
      x: "stored",
      r: [{ a: "da", b: "db" }],
    });
  });
});

describe("schema registry", () => {
  it("registers every design page", () => {
    expect(listPageContentSchemaPaths().sort()).toEqual(
      [
        "/about",
        "/committee",
        "/contact",
        "/home",
        "/join",
        "/rules",
      ].sort(),
    );
  });

  it("returns null for non-design paths", () => {
    expect(getPageContentSchema("/privacy")).toBeNull();
    expect(getPageContentSchema("/faq")).toBeNull();
    expect(getPageContentSchema("/admin")).toBeNull();
  });

  it("has unique field keys within each page", () => {
    for (const path of listPageContentSchemaPaths()) {
      const schema = getPageContentSchema(path)!;
      const keys = schema.sections.flatMap((section) =>
        section.fields.map((field) => field.key),
      );
      expect(new Set(keys).size, `duplicate field key on ${path}`).toBe(
        keys.length,
      );
    }
  });

  it("every rows-field default row only uses declared columns", () => {
    for (const path of listPageContentSchemaPaths()) {
      const schema = getPageContentSchema(path)!;
      for (const section of schema.sections) {
        for (const field of section.fields) {
          if (field.kind !== "rows") continue;
          const allowed = new Set(field.columns.map((column) => column.key));
          for (const row of field.default) {
            for (const key of Object.keys(row)) {
              expect(
                allowed.has(key),
                `${path}.${field.key} default has unknown column "${key}"`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });
});
