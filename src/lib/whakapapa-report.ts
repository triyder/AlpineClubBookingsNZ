export interface WhakapapaRoadStatus {
  name: string;
  status: string;
  wheelRequirements: string;
  roadContent: string;
}

export interface WhakapapaFacilityItem {
  name: string;
  status: string;
}

/**
 * @deprecated Retained as an alias for {@link WhakapapaFacilityItem}. The
 * Whakapapa report now groups items into Facilities, Food & Drink, and Lifts.
 */
export type WhakapapaChairlift = WhakapapaFacilityItem;

export interface WhakapapaCondition {
  name: string;
  temperature: string;
  wind: string;
  snowBase: string;
  snowfall24h: string;
  snowfall7d: string;
}

/**
 * Controls which articles the public widget renders. Each flag maps to one
 * article; `true` shows the article and `false` hides it. Missing flags default
 * to visible so legacy cached payloads keep rendering every section.
 */
export interface WhakapapaSectionVisibility {
  roadStatus: boolean;
  lifts: boolean;
  facilities: boolean;
  foodAndDrink: boolean;
  conditions: boolean;
}

export interface WhakapapaCurlData {
  updated: string;
  roadStatus: WhakapapaRoadStatus;
  facilities: WhakapapaFacilityItem[];
  foodAndDrink: WhakapapaFacilityItem[];
  lifts: WhakapapaFacilityItem[];
  conditions: WhakapapaCondition[];
  visibility: WhakapapaSectionVisibility;
}

export function emptyWhakapapaSectionVisibility(): WhakapapaSectionVisibility {
  return {
    roadStatus: true,
    lifts: true,
    facilities: true,
    foodAndDrink: true,
    conditions: true,
  };
}

export function coerceWhakapapaSectionVisibility(
  value: unknown,
): WhakapapaSectionVisibility {
  const defaults = emptyWhakapapaSectionVisibility();
  if (!value || typeof value !== "object") {
    return defaults;
  }

  const entry = value as Partial<
    Record<keyof WhakapapaSectionVisibility, unknown>
  >;
  const resolve = (key: keyof WhakapapaSectionVisibility): boolean =>
    typeof entry[key] === "boolean" ? (entry[key] as boolean) : defaults[key];

  return {
    roadStatus: resolve("roadStatus"),
    lifts: resolve("lifts"),
    facilities: resolve("facilities"),
    foodAndDrink: resolve("foodAndDrink"),
    conditions: resolve("conditions"),
  };
}

export function emptyWhakapapaCurlData(): WhakapapaCurlData {
  return {
    updated: "",
    roadStatus: {
      name: "",
      status: "",
      wheelRequirements: "",
      roadContent: "",
    },
    facilities: [],
    foodAndDrink: [],
    lifts: [],
    conditions: [],
    visibility: emptyWhakapapaSectionVisibility(),
  };
}

export function coerceWhakapapaCurlData(
  payload: unknown,
): WhakapapaCurlData | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as Partial<WhakapapaCurlData> & {
    roadStatus?: Partial<WhakapapaRoadStatus>;
    chairlifts?: unknown;
    visibility?: unknown;
  };

  if (!data.roadStatus || typeof data.roadStatus !== "object") {
    return null;
  }

  const facilities = coerceFacilityItems(data.facilities);
  const foodAndDrink = coerceFacilityItems(data.foodAndDrink);
  // Legacy payloads (cached or admin-frozen before the grouped split) stored
  // every item under `chairlifts`. Fall back to those so the widget keeps
  // showing lift data until the next upstream refresh.
  const lifts = Array.isArray(data.lifts)
    ? coerceFacilityItems(data.lifts)
    : coerceFacilityItems(data.chairlifts);

  const conditions = Array.isArray(data.conditions)
    ? data.conditions
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const entry = item as Partial<WhakapapaCondition>;
          return {
            name: typeof entry.name === "string" ? entry.name : "",
            temperature:
              typeof entry.temperature === "string" ? entry.temperature : "",
            wind: typeof entry.wind === "string" ? entry.wind : "",
            snowBase: typeof entry.snowBase === "string" ? entry.snowBase : "",
            snowfall24h:
              typeof entry.snowfall24h === "string" ? entry.snowfall24h : "",
            snowfall7d:
              typeof entry.snowfall7d === "string" ? entry.snowfall7d : "",
          };
        })
        .filter((item): item is WhakapapaCondition => item !== null)
    : [];

  return {
    updated: typeof data.updated === "string" ? data.updated : "",
    roadStatus: {
      name:
        typeof data.roadStatus.name === "string" ? data.roadStatus.name : "",
      status:
        typeof data.roadStatus.status === "string"
          ? data.roadStatus.status
          : "",
      wheelRequirements:
        typeof data.roadStatus.wheelRequirements === "string"
          ? data.roadStatus.wheelRequirements
          : "",
      roadContent:
        typeof data.roadStatus.roadContent === "string"
          ? data.roadStatus.roadContent
          : "",
    },
    facilities,
    foodAndDrink,
    lifts,
    conditions,
    visibility: coerceWhakapapaSectionVisibility(data.visibility),
  };
}

function coerceFacilityItems(value: unknown): WhakapapaFacilityItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const entry = item as Partial<WhakapapaFacilityItem>;
      return {
        name: typeof entry.name === "string" ? entry.name : "",
        status: typeof entry.status === "string" ? entry.status : "",
      };
    })
    .filter((item): item is WhakapapaFacilityItem => item !== null);
}
