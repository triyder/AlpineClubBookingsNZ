import { describe, expect, it } from "vitest";
import {
  coerceWhakapapaCurlData,
  coerceWhakapapaSectionVisibility,
  emptyWhakapapaSectionVisibility,
} from "@/lib/whakapapa-report";

// Regression coverage for the Whakapapa report coercion helpers that back the
// public widget and the admin editor (PR #1581 merged with zero tests, #1657).
// The invariants worth pinning: legacy `chairlifts`-only payloads still surface
// as `lifts`, missing visibility flags default to visible so cached rows keep
// rendering every section, and malformed entries are dropped rather than
// crashing the render.

describe("coerceWhakapapaSectionVisibility", () => {
  it("defaults every section to visible for a null/non-object value", () => {
    const allVisible = emptyWhakapapaSectionVisibility();
    expect(coerceWhakapapaSectionVisibility(null)).toEqual(allVisible);
    expect(coerceWhakapapaSectionVisibility(undefined)).toEqual(allVisible);
    expect(coerceWhakapapaSectionVisibility("nope")).toEqual(allVisible);
    expect(coerceWhakapapaSectionVisibility(42)).toEqual(allVisible);
  });

  it("keeps provided booleans and defaults missing flags to visible", () => {
    // A partial payload (only `conditions` set) must leave every other section
    // visible — this is what lets a legacy cached payload with no visibility
    // block keep rendering.
    expect(
      coerceWhakapapaSectionVisibility({ conditions: false, lifts: false }),
    ).toEqual({
      roadStatus: true,
      lifts: false,
      facilities: true,
      foodAndDrink: true,
      conditions: false,
    });
  });

  it("ignores non-boolean flag values and falls back to visible", () => {
    expect(
      coerceWhakapapaSectionVisibility({
        roadStatus: "false",
        lifts: 0,
        facilities: null,
        foodAndDrink: false,
        conditions: true,
      }),
    ).toEqual({
      roadStatus: true,
      lifts: true,
      facilities: true,
      foodAndDrink: false,
      conditions: true,
    });
  });
});

describe("coerceWhakapapaCurlData", () => {
  const roadStatus = {
    name: "Bruce Road",
    status: "Open",
    wheelRequirements: "Chains carried",
    roadContent: "Sealed to the top.",
  };

  it("returns null when the payload is missing or has no roadStatus object", () => {
    expect(coerceWhakapapaCurlData(null)).toBeNull();
    expect(coerceWhakapapaCurlData("not an object")).toBeNull();
    expect(coerceWhakapapaCurlData({})).toBeNull();
    expect(coerceWhakapapaCurlData({ roadStatus: "closed" })).toBeNull();
  });

  it("falls back to the legacy `chairlifts` payload when `lifts` is absent", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      chairlifts: [
        { name: "Waterfall Express", status: "Open" },
        { name: "Rangatira T-bar", status: "On hold" },
      ],
    });

    expect(result?.lifts).toEqual([
      { name: "Waterfall Express", status: "Open" },
      { name: "Rangatira T-bar", status: "On hold" },
    ]);
  });

  it("prefers `lifts` over the legacy `chairlifts` payload when both exist", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      lifts: [{ name: "Sky Waka", status: "Open" }],
      chairlifts: [{ name: "Waterfall Express", status: "Closed" }],
    });

    expect(result?.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("treats an empty `lifts` array as the current shape rather than falling back", () => {
    // `lifts: []` means "no lifts running", not "legacy payload". The fallback
    // only fires when `lifts` is not an array at all.
    const result = coerceWhakapapaCurlData({
      roadStatus,
      lifts: [],
      chairlifts: [{ name: "Waterfall Express", status: "Open" }],
    });

    expect(result?.lifts).toEqual([]);
  });

  it("defaults visibility to all-visible when the payload omits it", () => {
    const result = coerceWhakapapaCurlData({ roadStatus });
    expect(result?.visibility).toEqual(emptyWhakapapaSectionVisibility());
  });

  it("carries an explicit partial visibility block through, defaulting the rest", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      visibility: { facilities: false },
    });
    expect(result?.visibility).toEqual({
      roadStatus: true,
      lifts: true,
      facilities: false,
      foodAndDrink: true,
      conditions: true,
    });
  });

  it("drops malformed facility/food/lift entries and coerces missing fields to strings", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      facilities: [
        { name: "Cafe", status: "Open" },
        null,
        "not an object",
        { name: 12, status: false }, // non-string fields → ""
      ],
      foodAndDrink: [{ name: "Knoll Ridge" }],
      lifts: [{ status: "Closed" }],
    });

    expect(result?.facilities).toEqual([
      { name: "Cafe", status: "Open" },
      { name: "", status: "" },
    ]);
    expect(result?.foodAndDrink).toEqual([{ name: "Knoll Ridge", status: "" }]);
    expect(result?.lifts).toEqual([{ name: "", status: "Closed" }]);
  });

  it("drops malformed condition rows and coerces each metric field to a string", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      conditions: [
        {
          name: "Top",
          temperature: "-3",
          wind: "25 km/h",
          snowBase: "120 cm",
          snowfall24h: "5 cm",
          snowfall7d: "30 cm",
        },
        null,
        "bad",
        { name: 5 }, // partial + non-string → all defaults
      ],
    });

    expect(result?.conditions).toEqual([
      {
        name: "Top",
        temperature: "-3",
        wind: "25 km/h",
        snowBase: "120 cm",
        snowfall24h: "5 cm",
        snowfall7d: "30 cm",
      },
      {
        name: "",
        temperature: "",
        wind: "",
        snowBase: "",
        snowfall24h: "",
        snowfall7d: "",
      },
    ]);
  });

  it("coerces non-array section fields to empty arrays", () => {
    const result = coerceWhakapapaCurlData({
      roadStatus,
      facilities: "nope",
      foodAndDrink: 3,
      conditions: { not: "an array" },
    });

    expect(result?.facilities).toEqual([]);
    expect(result?.foodAndDrink).toEqual([]);
    expect(result?.lifts).toEqual([]);
    expect(result?.conditions).toEqual([]);
  });

  it("coerces roadStatus and `updated` fields, defaulting non-strings to empty", () => {
    const result = coerceWhakapapaCurlData({
      updated: 123,
      roadStatus: { name: "Bruce Road", status: 7 },
    });

    expect(result?.updated).toBe("");
    expect(result?.roadStatus).toEqual({
      name: "Bruce Road",
      status: "",
      wheelRequirements: "",
      roadContent: "",
    });
  });
});
