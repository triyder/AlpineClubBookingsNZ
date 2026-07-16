import { describe, expect, it } from "vitest";
import {
  parseTokenParameters,
  resolveFeeTokenParameters,
} from "@/lib/token-parameters";

describe("parseTokenParameters (embed token grammar, #1933)", () => {
  it("returns empty for no parameter", () => {
    const parsed = parseTokenParameters(undefined);
    expect(parsed.positional).toEqual([]);
    expect(parsed.params.size).toBe(0);
    expect(parseTokenParameters("").positional).toEqual([]);
    expect(parseTokenParameters(null).params.size).toBe(0);
  });

  it("treats a bare segment as a positional (back-compat lodge slug)", () => {
    const parsed = parseTokenParameters("whakapapa-river-lodge");
    expect(parsed.positional).toEqual(["whakapapa-river-lodge"]);
    expect(parsed.params.size).toBe(0);
  });

  it("parses a single key=value", () => {
    const parsed = parseTokenParameters("lodge=whakapapa");
    expect(parsed.positional).toEqual([]);
    expect(parsed.params.get("lodge")).toEqual(["whakapapa"]);
  });

  it("parses comma-separated mixed positional and key=value with whitespace", () => {
    const parsed = parseTokenParameters("  river-lodge , type=full ,  group-by = age ");
    expect(parsed.positional).toEqual(["river-lodge"]);
    expect(parsed.params.get("type")).toEqual(["full"]);
    expect(parsed.params.get("group-by")).toEqual(["age"]);
  });

  it("splits multi-value on + (e.g. group-by=type+age)", () => {
    expect(parseTokenParameters("group-by=type+age").params.get("group-by")).toEqual(["type", "age"]);
    expect(parseTokenParameters("group-by = type + age").params.get("group-by")).toEqual(["type", "age"]);
  });

  it("lower-cases keys but preserves value casing", () => {
    const parsed = parseTokenParameters("TYPE=Full, Lodge=River");
    expect(parsed.params.get("type")).toEqual(["Full"]);
    expect(parsed.params.get("lodge")).toEqual(["River"]);
  });

  it("drops malformed segments without throwing", () => {
    const parsed = parseTokenParameters(",=orphan, , type=, =");
    expect(parsed.positional).toEqual([]);
    // "type=" yields a key with no values; "=orphan"/"=" have no key and are dropped.
    expect(parsed.params.has("type")).toBe(true);
    expect(parsed.params.get("type")).toEqual([]);
  });

  it("accumulates repeated keys", () => {
    expect(parseTokenParameters("group-by=type, group-by=age").params.get("group-by")).toEqual(["type", "age"]);
  });
});

describe("resolveFeeTokenParameters (fee-embed semantics, #1933)", () => {
  it("maps the first non-alias positional to lodge and reads type/group-by", () => {
    const resolved = resolveFeeTokenParameters("river-lodge, type=full, group-by=age");
    expect(resolved.lodge).toBe("river-lodge");
    expect(resolved.type).toBe("full");
    expect(resolved.groupBy).toEqual(new Set(["age"]));
    expect(resolved.components).toBe(false);
  });

  it("prefers an explicit lodge= over the positional", () => {
    expect(resolveFeeTokenParameters("river-lodge, lodge=chalet").lodge).toBe("chalet");
  });

  it("treats the bare by-age positional as group-by=age, not a lodge slug", () => {
    const resolved = resolveFeeTokenParameters("by-age");
    expect(resolved.groupBy).toEqual(new Set(["age"]));
    expect(resolved.lodge).toBeUndefined();
  });

  it("supports group-by=type+age multi-value", () => {
    expect(resolveFeeTokenParameters("group-by=type+age").groupBy).toEqual(new Set(["type", "age"]));
  });

  it("ignores unknown group-by values (never crashes, never leaks)", () => {
    expect(resolveFeeTokenParameters("group-by=colour").groupBy).toEqual(new Set());
  });

  it("detects the components flag (bare positional or key form) for annual fees", () => {
    expect(resolveFeeTokenParameters("components").components).toBe(true);
    expect(resolveFeeTokenParameters("components=1").components).toBe(true);
    expect(resolveFeeTokenParameters("type=full, components").components).toBe(true);
    expect(resolveFeeTokenParameters("type=full").components).toBe(false);
    // A bare "components" is a flag, not the lodge slug.
    expect(resolveFeeTokenParameters("components").lodge).toBeUndefined();
  });
});
