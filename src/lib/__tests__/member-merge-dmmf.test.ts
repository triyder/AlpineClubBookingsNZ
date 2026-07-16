import { readFileSync } from "fs";
import { join } from "path";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  MEMBER_MERGE_RELATION_SPECS,
  diffRelationSpecCoverage,
  memberRelationNamesFromDmmf,
  parseMemberRelationOwnerKeys,
} from "@/lib/member-merge";

const schemaText = readFileSync(
  join(process.cwd(), "prisma", "schema.prisma"),
  "utf8",
);

const specKeys = MEMBER_MERGE_RELATION_SPECS.map((s) => s.key);

describe("member-merge relation classification completeness", () => {
  it("classifies every Member FK-owning relation exactly once (no missing, no extra)", () => {
    const ownerKeys = parseMemberRelationOwnerKeys(schemaText);
    const { missing, extra } = diffRelationSpecCoverage(ownerKeys, specKeys);

    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it("has no duplicate spec keys (each relation in exactly one bucket)", () => {
    const seen = new Set<string>();
    for (const key of specKeys) {
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("FAILS when the schema grows an unclassified Member relation (fixture proof)", () => {
    const injected = `${schemaText}
model FutureThing {
  id        String @id @default(cuid())
  memberId  String
  member    Member @relation("FutureThingMember", fields: [memberId], references: [id], onDelete: Cascade)
}
`;
    const ownerKeys = parseMemberRelationOwnerKeys(injected);
    const { missing } = diffRelationSpecCoverage(ownerKeys, specKeys);

    expect(missing).toContain("FutureThing.member");
  });

  it("FAILS when a spec key no longer exists in the schema (fixture proof)", () => {
    const ownerKeys = parseMemberRelationOwnerKeys(schemaText);
    const { extra } = diffRelationSpecCoverage(ownerKeys, [
      ...specKeys,
      "GhostModel.member",
    ]);

    expect(extra).toContain("GhostModel.member");
  });

  it("cross-checks against the runtime DMMF: the trimmed DMMF exposes Member relations", () => {
    const relNames = memberRelationNamesFromDmmf(
      Prisma.dmmf.datamodel.models as unknown as {
        name: string;
        fields: { type: string; relationName?: string }[];
      }[],
    );
    expect(relNames.size).toBeGreaterThan(0);
  });

  it("parses a relation field with attributes BEFORE @relation (fail-open regression proof)", () => {
    const injected = `${schemaText}
model AttributeFirstThing {
  id       String @id @default(cuid())
  memberId String
  member   Member @ignore @relation("AttributeFirstThingMember", fields: [memberId], references: [id], onDelete: Cascade)
}
`;
    const ownerKeys = parseMemberRelationOwnerKeys(injected);
    expect(ownerKeys).toContain("AttributeFirstThing.member");
  });

  // ---------------------------------------------------------------------
  // Fail-closed cross-check: the trimmed runtime DMMF (which drops isList /
  // relationFromFields) supplies the authoritative UNIVERSE of Member-typed
  // relation fields; a deliberately loose schema scan supplies only their
  // declared type token (Member / Member? / Member[]). Every non-list field
  // in that universe must map to a parsed owner key, so a field the strict
  // owner-key parser fails to parse (attribute quirks, formatting) becomes a
  // CI failure instead of silently dying with the loser. All singular Member
  // fields carry `fields:` today — verified at review time.
  // ---------------------------------------------------------------------

  /** `Model.field` -> declared type token for every Member-typed field. */
  function memberFieldTypeTokens(schema: string): Map<string, string> {
    const map = new Map<string, string>();
    let model: string | null = null;
    for (const line of schema.split(/\r?\n/)) {
      const mm = line.match(/^model\s+(\w+)\s*\{/);
      if (mm) {
        model = mm[1];
        continue;
      }
      if (line.trim() === "}") {
        model = null;
        continue;
      }
      const fm = line.match(/^\s*(\w+)\s+(Member(?:\[\]|\?)?)(\s|$)/);
      if (fm && model) map.set(`${model}.${fm[1]}`, fm[2]);
    }
    return map;
  }

  function unparsedSingularMemberFields(
    models: readonly {
      name: string;
      fields: readonly { name: string; kind: string; type: string }[];
    }[],
    ownerKeys: ReadonlySet<string>,
    typeTokens: ReadonlyMap<string, string>,
  ): string[] {
    const unparsed: string[] = [];
    for (const model of models) {
      for (const field of model.fields) {
        if (field.kind !== "object" || field.type !== "Member") continue;
        const key = `${model.name}.${field.name}`;
        // List back-refs own no FK. A field the loose scan cannot even see
        // (no type token) is NEVER skipped — it is reported as unparsed.
        if (typeTokens.get(key) === "Member[]") continue;
        if (!ownerKeys.has(key)) unparsed.push(key);
      }
    }
    return unparsed;
  }

  it("every singular Member-typed DMMF field maps to a parsed owner key (fail-closed)", () => {
    const ownerKeys = new Set(parseMemberRelationOwnerKeys(schemaText));
    const typeTokens = memberFieldTypeTokens(schemaText);
    const models = Prisma.dmmf.datamodel.models as unknown as {
      name: string;
      fields: { name: string; kind: string; type: string }[];
    }[];
    // Sanity: the walk actually sees at least as many singular fields as the
    // spec table classifies.
    const singularCount = models
      .flatMap((m) => m.fields.map((f) => ({ model: m.name, ...f })))
      .filter(
        (f) =>
          f.kind === "object" &&
          f.type === "Member" &&
          typeTokens.get(`${f.model}.${f.name}`) !== "Member[]",
      ).length;
    expect(singularCount).toBeGreaterThanOrEqual(MEMBER_MERGE_RELATION_SPECS.length);

    expect(unparsedSingularMemberFields(models, ownerKeys, typeTokens)).toEqual([]);
  });

  it("FAILS on a hypothetical relation the owner-key parser cannot see (fixture proof)", () => {
    const ownerKeys = new Set(parseMemberRelationOwnerKeys(schemaText));
    const typeTokens = memberFieldTypeTokens(schemaText);
    const withGhost = [
      {
        name: "GhostModel",
        fields: [{ name: "member", kind: "object", type: "Member" }],
      },
    ];
    // GhostModel.member is in the (fixture) DMMF universe but invisible to
    // both schema scans -> reported, never silently skipped.
    expect(unparsedSingularMemberFields(withGhost, ownerKeys, typeTokens)).toEqual([
      "GhostModel.member",
    ]);
  });

  it("every spec key names a real DMMF model.field whose type is Member (catches typos)", () => {
    const modelByName = new Map(
      Prisma.dmmf.datamodel.models.map((m) => [m.name, m]),
    );
    for (const s of MEMBER_MERGE_RELATION_SPECS) {
      const model = modelByName.get(s.model);
      expect(model, `unknown model ${s.model}`).toBeDefined();
      const field = model?.fields.find((f) => f.name === s.field);
      expect(field, `unknown field ${s.key}`).toBeDefined();
      expect(field?.type, `${s.key} is not a Member relation`).toBe("Member");
    }
  });
});
