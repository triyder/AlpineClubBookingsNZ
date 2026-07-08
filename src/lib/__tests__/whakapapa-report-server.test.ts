import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWhakapapaCurlData } from "@/lib/whakapapa-report.server";

// Regression coverage for the upstream Whakapapa report scraper (PR #1581,
// #1657). The parser routes the three status groups by heading id AND falls
// back to the heading text so an upstream markup id change does not silently
// drop a group. Both routing paths are pinned here over a fixture DOM.

type SectionSpec = { id: string; label: string; items: [string, string][] };

function section({ id, label, items }: SectionSpec): string {
  const itemHtml = items
    .map(
      ([name, status]) => `
      <div class="item_3CiH98">
        <div class="name_3CiH98">${name}</div>
        <div class="status_3CiH98">${status}</div>
      </div>`,
    )
    .join("");
  const idAttr = id ? ` id="${id}"` : "";
  return `
    <div class="wrapper_2hnOFJ">
      <div class="title_2hnOFJ"${idAttr}>${label}</div>
      <div class="items_2hnOFJ">${itemHtml}</div>
    </div>`;
}

function metric(label: string, value: string): string {
  return `<div class="metric"><div>${label}</div><div>${value}</div></div>`;
}

function conditionRow(name: string): string {
  return `
    <div class="locationRow_1pp0Bo">
      <div class="locationTitle_1pp0Bo">${name}</div>
      <div class="temperature_1pp0Bo">-3°C</div>
      ${metric("Wind", "25 km/h")}
      ${metric("Snow Base", "120 cm")}
      ${metric("24 hr Snowfall", "5 cm")}
      ${metric("7 day Snowfall", "30 cm")}
    </div>`;
}

function buildHtml(sections: SectionSpec[], conditionNames: string[]): string {
  return `<!doctype html><html><body>
    <div class="areaTitle_3oPk4X">Bruce Road</div>
    <span class="open_3oPk4X">Open</span>
    <div class="wheelRequirements_3oPk4X">Chains must be carried</div>
    <div class="roadContent_3oPk4X">Sealed to the car park.</div>
    ${sections.map(section).join("")}
    ${conditionNames.map(conditionRow).join("")}
  </body></html>`;
}

function mockFetchHtml(
  html: string,
  init: { ok?: boolean; status?: number } = {},
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => html,
    }),
  );
}

const CANONICAL_SECTIONS: SectionSpec[] = [
  { id: "facilities", label: "Facilities", items: [["Ticket Office", "Open"]] },
  {
    id: "food-drink",
    label: "Food & Drink",
    items: [["Knoll Ridge Cafe", "Closed"]],
  },
  { id: "lifts", label: "Lifts", items: [["Sky Waka", "Open"]] },
];

describe("fetchWhakapapaCurlData", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses road status, groups, and conditions from the report DOM", async () => {
    mockFetchHtml(buildHtml(CANONICAL_SECTIONS, ["Top of Waterfall"]));

    const data = await fetchWhakapapaCurlData();

    expect(data.roadStatus).toEqual({
      name: "Bruce Road",
      status: "Open",
      wheelRequirements: "Chains must be carried",
      roadContent: "Sealed to the car park.",
    });
    expect(data.conditions).toEqual([
      {
        name: "Top of Waterfall",
        temperature: "-3°C",
        wind: "25 km/h",
        snowBase: "120 cm",
        snowfall24h: "5 cm",
        snowfall7d: "30 cm",
      },
    ]);
    // `updated` is stamped from the fetch time.
    expect(data.updated).not.toBe("");
  });

  it("routes the three groups by heading id", async () => {
    mockFetchHtml(buildHtml(CANONICAL_SECTIONS, []));

    const data = await fetchWhakapapaCurlData();

    expect(data.facilities).toEqual([{ name: "Ticket Office", status: "Open" }]);
    expect(data.foodAndDrink).toEqual([
      { name: "Knoll Ridge Cafe", status: "Closed" },
    ]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("falls back to heading text when the upstream ids change (pins the fallback)", async () => {
    // Simulate an upstream markup change: the ids are renamed/removed but the
    // human-readable heading text is unchanged. Routing must still work so a
    // group is never silently dropped.
    const renamed: SectionSpec[] = [
      { id: "", label: "Facilities", items: [["Ticket Office", "Open"]] },
      {
        id: "group-2",
        label: "Food & Drink",
        items: [["Knoll Ridge Cafe", "Closed"]],
      },
      { id: "", label: "Lifts", items: [["Sky Waka", "Open"]] },
    ];
    mockFetchHtml(buildHtml(renamed, []));

    const data = await fetchWhakapapaCurlData();

    expect(data.facilities).toEqual([{ name: "Ticket Office", status: "Open" }]);
    expect(data.foodAndDrink).toEqual([
      { name: "Knoll Ridge Cafe", status: "Closed" },
    ]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("ignores groups whose id and text both fail to match a known group", async () => {
    const unknown: SectionSpec[] = [
      { id: "weather", label: "Weather", items: [["Cloud", "High"]] },
      { id: "lifts", label: "Lifts", items: [["Sky Waka", "Open"]] },
    ];
    mockFetchHtml(buildHtml(unknown, []));

    const data = await fetchWhakapapaCurlData();

    expect(data.facilities).toEqual([]);
    expect(data.foodAndDrink).toEqual([]);
    expect(data.lifts).toEqual([{ name: "Sky Waka", status: "Open" }]);
  });

  it("drops condition rows without a name and returns '' for absent metrics", async () => {
    const html = `<!doctype html><html><body>
      <div class="locationRow_1pp0Bo">
        <div class="locationTitle_1pp0Bo">Top</div>
        ${metric("Wind", "10 km/h")}
      </div>
      <div class="locationRow_1pp0Bo">
        <div class="locationTitle_1pp0Bo"></div>
        ${metric("Wind", "40 km/h")}
      </div>
    </body></html>`;
    mockFetchHtml(html);

    const data = await fetchWhakapapaCurlData();

    expect(data.conditions).toEqual([
      {
        name: "Top",
        temperature: "",
        wind: "10 km/h",
        snowBase: "",
        snowfall24h: "",
        snowfall7d: "",
      },
    ]);
  });

  it("throws when the upstream response is not ok", async () => {
    mockFetchHtml("<html></html>", { ok: false, status: 503 });
    await expect(fetchWhakapapaCurlData()).rejects.toThrow(/status 503/);
  });

  it("throws when the upstream response body is empty", async () => {
    mockFetchHtml("   ", { ok: true, status: 200 });
    await expect(fetchWhakapapaCurlData()).rejects.toThrow(
      /Whakapapa report fetch failed/,
    );
  });
});
