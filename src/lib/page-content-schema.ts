/**
 * Structured editable content contract for code-backed website pages.
 *
 * The CMS stores these values in PageContent.structuredContent. Routes that
 * opt into a schema can keep layout in code while letting admins edit plain
 * text and image URL slots. Existing rich-text CMS pages keep using contentHtml.
 */

export type StructuredRow = Record<string, string>;
export type StructuredFieldValue = string | StructuredRow[];
export type StructuredContentValues = Record<string, StructuredFieldValue>;

export type ScalarFieldType = "text" | "multiline" | "select" | "image";

export type ScalarFieldSpec = {
  kind: "scalar";
  key: string;
  label: string;
  type: ScalarFieldType;
  maxLength: number;
  help?: string;
  default: string;
  options?: string[];
};

export type RowColumnSpec = {
  key: string;
  label: string;
  type: ScalarFieldType;
  maxLength: number;
};

export type RowsFieldSpec = {
  kind: "rows";
  key: string;
  label: string;
  help?: string;
  columns: RowColumnSpec[];
  maxRows: number;
  default: StructuredRow[];
};

export type FieldSpec = ScalarFieldSpec | RowsFieldSpec;

export type PageSection = {
  title: string;
  description?: string;
  fields: FieldSpec[];
};

export type PageContentSchema = {
  path: string;
  label: string;
  sections: PageSection[];
};

function genericPageSchema({
  path,
  label,
  intro,
  heading,
}: {
  path: string;
  label: string;
  intro: string;
  heading: string;
}): PageContentSchema {
  return {
    path,
    label,
    sections: [
      {
        title: "Page header",
        fields: [
          {
            kind: "scalar",
            key: "heroImage",
            label: "Header background image",
            type: "image",
            maxLength: 500,
            help: "Optional image URL for code-backed page designs.",
            default: "",
          },
          {
            kind: "scalar",
            key: "intro",
            label: "Intro text",
            type: "multiline",
            maxLength: 2000,
            default: intro,
          },
        ],
      },
      {
        title: "Body sections",
        fields: [
          {
            kind: "rows",
            key: "bodySections",
            label: "Body sections",
            help: "Each row is a section a code-backed page can render in order.",
            maxRows: 12,
            columns: [
              {
                key: "heading",
                label: "Heading",
                type: "text",
                maxLength: 160,
              },
              {
                key: "body",
                label: "Body",
                type: "multiline",
                maxLength: 4000,
              },
            ],
            default: [{ heading, body: intro }],
          },
        ],
      },
    ],
  };
}

const PAGE_CONTENT_SCHEMAS: Record<string, PageContentSchema> = Object.fromEntries(
  [
    genericPageSchema({
      path: "/home",
      label: "Home",
      heading: "Welcome",
      intro:
        "Our club lodge welcomes members and guests year-round. Book a stay, join the club, and explore New Zealand's mountains.",
    }),
    genericPageSchema({
      path: "/about",
      label: "About",
      heading: "About the Club",
      intro: "Learn about our club history, values, and alpine community.",
    }),
    genericPageSchema({
      path: "/join",
      label: "Join",
      heading: "Becoming a Member",
      intro:
        "Nomination by two current members, induction process, and membership details.",
    }),
    genericPageSchema({
      path: "/rules",
      label: "Rules",
      heading: "Lodge Rules",
      intro:
        "Lodge rules and expectations for members and guests staying at the lodge.",
    }),
    genericPageSchema({
      path: "/contact",
      label: "Contact",
      heading: "Contact Us",
      intro:
        "Have a question about the club, the lodge, or booking a stay? Get in touch and we'll get back to you.",
    }),
    genericPageSchema({
      path: "/committee",
      label: "Committee",
      heading: "Committee",
      intro:
        "The club is run entirely by volunteers. Meet the committee members who keep things going.",
    }),
  ].map((schema) => [schema.path, schema]),
);

export function getPageContentSchema(path: string): PageContentSchema | null {
  return PAGE_CONTENT_SCHEMAS[path] ?? null;
}

export function listPageContentSchemaPaths(): string[] {
  return Object.keys(PAGE_CONTENT_SCHEMAS);
}

export function flattenPageFields(
  schema: PageContentSchema,
): Record<string, FieldSpec> {
  const out: Record<string, FieldSpec> = {};
  for (const section of schema.sections) {
    for (const field of section.fields) {
      out[field.key] = field;
    }
  }
  return out;
}

export function toStructuredContentValues(
  value: unknown,
): StructuredContentValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: StructuredContentValues = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") {
      out[key] = raw;
    } else if (Array.isArray(raw)) {
      const rows: StructuredRow[] = [];
      for (const item of raw) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const row: StructuredRow = {};
          for (const [cellKey, cellValue] of Object.entries(
            item as Record<string, unknown>,
          )) {
            if (typeof cellValue === "string") {
              row[cellKey] = cellValue;
            }
          }
          rows.push(row);
        }
      }
      out[key] = rows;
    }
  }
  return out;
}

export function pickText(
  values: StructuredContentValues | null | undefined,
  spec: ScalarFieldSpec,
): string {
  const raw = values?.[spec.key];
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return spec.default;
}

export function pickRows(
  values: StructuredContentValues | null | undefined,
  spec: RowsFieldSpec,
): StructuredRow[] {
  const raw = values?.[spec.key];
  if (Array.isArray(raw)) {
    const rows = raw
      .map((row) => {
        const mapped: StructuredRow = {};
        for (const column of spec.columns) {
          const cell = row?.[column.key];
          mapped[column.key] = typeof cell === "string" ? cell.trim() : "";
        }
        return mapped;
      })
      .filter((row) => spec.columns.some((column) => row[column.key]));
    if (rows.length > 0) {
      return rows;
    }
  }
  return spec.default;
}

export function buildEditableStructuredValues(
  schema: PageContentSchema,
  stored: StructuredContentValues | null | undefined,
): StructuredContentValues {
  const out: StructuredContentValues = {};
  for (const section of schema.sections) {
    for (const field of section.fields) {
      if (field.kind === "scalar") {
        out[field.key] = pickText(stored, field);
      } else {
        out[field.key] = pickRows(stored, field).map((row) => ({ ...row }));
      }
    }
  }
  return out;
}
