import { JSDOM } from "jsdom";
import {
  emptyWhakapapaCurlData,
  type WhakapapaCondition,
  type WhakapapaCurlData,
  type WhakapapaFacilityItem,
  type WhakapapaRoadStatus,
} from "@/lib/whakapapa-report";

const WHAKAPAPA_REPORT_URL = "https://www.whakapapa.com/report";

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLabel(value: string): string {
  return value.replace(/:\s*$/, "").trim().toLowerCase();
}

function parseFacilityItems(section: ParentNode): WhakapapaFacilityItem[] {
  return Array.from(section.querySelectorAll("div.item_3CiH98"))
    .map((node) => ({
      name: normalizeText(node.querySelector("div.name_3CiH98")?.textContent),
      status: normalizeText(
        node.querySelector("div.status_3CiH98")?.textContent,
      ),
    }))
    .filter((item) => item.name.length > 0 || item.status.length > 0);
}

function findMetricValue(container: ParentNode, title: string): string {
  const target = normalizeLabel(title);
  const titleNodes = Array.from(container.querySelectorAll("div"));

  for (const node of titleNodes) {
    const nodeLabel = normalizeLabel(normalizeText(node.textContent));
    if (nodeLabel !== target) {
      continue;
    }

    const nextSiblingText = normalizeText(node.nextElementSibling?.textContent);
    if (nextSiblingText) {
      return nextSiblingText;
    }

    const parent = node.parentElement;
    if (!parent) {
      continue;
    }

    const parentChildren = Array.from(parent.children);
    const nodeIndex = parentChildren.indexOf(node);
    if (nodeIndex >= 0) {
      for (let i = nodeIndex + 1; i < parentChildren.length; i += 1) {
        const siblingText = normalizeText(parentChildren[i]?.textContent);
        if (siblingText && normalizeLabel(siblingText) !== target) {
          return siblingText;
        }
      }
    }
  }

  return "";
}

export async function fetchWhakapapaCurlData(): Promise<WhakapapaCurlData> {
  const upstream = await fetch(WHAKAPAPA_REPORT_URL, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "AlpineClubBookingsNZ/1.0 (+whakapapa-report)",
    },
    cache: "no-store",
  });

  const html = await upstream.text();
  if (!upstream.ok || html.trim().length === 0) {
    throw new Error(
      `Whakapapa report fetch failed (status ${upstream.status}).`,
    );
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;

  const roadStatus: WhakapapaRoadStatus = {
    name: normalizeText(
      document
        .querySelector("div.areaTitle_3oPk4X")
        ?.textContent?.split(":")[0],
    ),
    status: normalizeText(
      document.querySelector("span.open_3oPk4X, span.closed_3oPk4X")
        ?.textContent,
    ),
    wheelRequirements: normalizeText(
      document.querySelector("div.wheelRequirements_3oPk4X")?.textContent,
    ),
    roadContent: normalizeText(
      document.querySelector("div.roadContent_3oPk4X")?.textContent,
    ),
  };

  const facilities: WhakapapaFacilityItem[] = [];
  const foodAndDrink: WhakapapaFacilityItem[] = [];
  const lifts: WhakapapaFacilityItem[] = [];

  // The report groups status items into Facilities, Food & Drink, and Lifts.
  // Each group is a `wrapper_2hnOFJ` section with a titled heading and an
  // `items_2hnOFJ` list. Route items by the heading id, falling back to the
  // heading text so a markup id change does not silently drop a group.
  const sectionWrappers = Array.from(
    document.querySelectorAll("div.wrapper_2hnOFJ"),
  );
  for (const wrapper of sectionWrappers) {
    const heading = wrapper.querySelector(".title_2hnOFJ");
    const headingId = heading?.id ?? "";
    const headingLabel = normalizeLabel(normalizeText(heading?.textContent));
    const itemsContainer = wrapper.querySelector("div.items_2hnOFJ");
    if (!itemsContainer) {
      continue;
    }

    const items = parseFacilityItems(itemsContainer);
    if (headingId === "facilities" || headingLabel === "facilities") {
      facilities.push(...items);
    } else if (headingId === "food-drink" || headingLabel === "food & drink") {
      foodAndDrink.push(...items);
    } else if (headingId === "lifts" || headingLabel === "lifts") {
      lifts.push(...items);
    }
  }

  const conditionNodes = Array.from(
    document.querySelectorAll("div.locationRow_1pp0Bo"),
  );
  const conditions: WhakapapaCondition[] = conditionNodes
    .map((node) => ({
      name: normalizeText(
        node.querySelector("div.locationTitle_1pp0Bo")?.textContent,
      ),
      temperature: normalizeText(
        node.querySelector("div.temperature_1pp0Bo")?.textContent,
      ),
      wind: findMetricValue(node, "Wind"),
      snowBase: findMetricValue(node, "Snow Base"),
      snowfall24h: findMetricValue(node, "24 hr Snowfall"),
      snowfall7d: findMetricValue(node, "7 day Snowfall"),
    }))
    .filter((item) => item.name.length > 0);

  const curlData = emptyWhakapapaCurlData();
  curlData.updated = new Date().toISOString();
  curlData.roadStatus = roadStatus;
  curlData.facilities = facilities;
  curlData.foodAndDrink = foodAndDrink;
  curlData.lifts = lifts;
  curlData.conditions = conditions;

  return curlData;
}
