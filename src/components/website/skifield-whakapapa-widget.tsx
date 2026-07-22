"use client";

import { useEffect, useState } from "react";
import {
  emptyWhakapapaSectionVisibility,
  type WhakapapaCurlData,
  type WhakapapaFacilityItem,
} from "@/lib/whakapapa-report";

type ApiResponse = WhakapapaCurlData & { error?: string; stale?: boolean };

function StatusCell({ status }: { status: string }) {
  const normalized = status.trim().toLowerCase();

  if (normalized === "open") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-success-11 bg-success-3">
        {status}
      </span>
    );
  }

  if (normalized === "closed") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-danger-11 bg-danger-3">
        {status}
      </span>
    );
  }

  if (normalized === "coming soon") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-muted-foreground bg-muted">
        {status}
      </span>
    );
  }

  if (normalized === "limited availability") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-warning-11 bg-warning-3">
        {status}
      </span>
    );
  }

  return (
    <span className="block w-full text-center">{status || "Unknown"}</span>
  );
}

function FacilityGroup({
  id,
  title,
  items,
  emptyLabel,
}: {
  id: string;
  title: string;
  items: WhakapapaFacilityItem[];
  emptyLabel: string;
}) {
  return (
    <article
      id={id}
      className="rounded-md border border-border bg-card p-2"
    >
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {items.length > 0 ? (
        <div
          className={`mt-2 flex flex-wrap gap-2 ${title.replace(/\s+/g, "-").toLowerCase()}-status-container`}
        >
          {items.map((item) => (
            <div
              key={`${item.name}-${item.status}`}
              className={`flex flex-col gap-1 rounded-md border border-border bg-card p-2 ${title.replace(/\s+/g, "-").toLowerCase()}-status-item`}
            >
              <span
                className={`text-xs font-medium text-foreground ${title.replace(/\s+/g, "-").toLowerCase()}-status-description`}
              >
                {item.name || "Unknown"}
              </span>
              <StatusCell status={item.status} />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">{emptyLabel}</p>
      )}
    </article>
  );
}

const EMPTY_DATA: WhakapapaCurlData = {
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

export function SkifieldWhakapapaWidget() {
  const [data, setData] = useState<WhakapapaCurlData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const response = await fetch("/api/skifield-whakapapa", {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json()) as ApiResponse;
        if (!active) {
          return;
        }

        setData({
          updated: payload.updated || "",
          roadStatus: {
            name: payload.roadStatus?.name || "",
            status: payload.roadStatus?.status || "",
            wheelRequirements: payload.roadStatus?.wheelRequirements || "",
            roadContent: payload.roadStatus?.roadContent || "",
          },
          facilities: payload.facilities ?? [],
          foodAndDrink: payload.foodAndDrink ?? [],
          lifts: payload.lifts ?? [],
          conditions: payload.conditions ?? [],
          visibility: payload.visibility ?? emptyWhakapapaSectionVisibility(),
        });

        setError(payload.error || "");
        setStale(Boolean(payload.stale));
      } catch {
        if (!active) {
          return;
        }
        setError("Unable to load Whakapapa report data.");
        setStale(false);
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="rounded-md border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        Loading Whakapapa report...
      </div>
    );
  }

  const formattedUpdated = data.updated
    ? new Date(data.updated).toLocaleString("en-NZ", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown";

  const roadStatusTone = /open/i.test(data.roadStatus.status)
    ? "bg-success-3 text-success-11"
    : data.roadStatus.status
      ? "bg-warning-3 text-warning-11"
      : "bg-muted text-muted-foreground";

  return (
    <section
      id="conditions"
      className="rounded-lg border border-border bg-card p-2 shadow-sm sm:p-4"
    >
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Whakapapa Conditions
          </h2>
          <p className="text-xs text-muted-foreground">Updated: {formattedUpdated}</p>
        </div>
        {stale ? (
          <span className="inline-flex rounded-full bg-warning-3 px-2 py-1 text-xs font-medium text-warning-11">
            Showing cached data
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mb-3 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-xs text-warning-11">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          {data.visibility.roadStatus ? (
            <article
              id="whakapapa-road-status"
              className="rounded-md border border-border bg-card p-2"
            >
              <h3 className="text-sm font-semibold text-foreground">
                Road Status
              </h3>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="sm:flex-1">
                  <div className="text-xs text-muted-foreground">
                    <span>{data.roadStatus.name || "Unknown road"}&nbsp;</span>
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${roadStatusTone}`}
                    >
                      {data.roadStatus.status || "Status unavailable"}
                    </span>
                  </div>
                </div>
                {data.roadStatus.wheelRequirements ||
                data.roadStatus.roadContent ? (
                  <dl className="space-y-2 text-xs text-muted-foreground sm:flex-1">
                    {data.roadStatus.wheelRequirements ? (
                      <div>
                        <dt className="font-medium text-muted-foreground">
                          Wheel requirements
                        </dt>
                        <dd>{data.roadStatus.wheelRequirements}</dd>
                      </div>
                    ) : null}
                    {data.roadStatus.roadContent ? (
                      <div>
                        <dt className="font-medium text-muted-foreground">
                          Road content
                        </dt>
                        <dd>{data.roadStatus.roadContent}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
              </div>
            </article>
          ) : null}

          {data.visibility.foodAndDrink ? (
            <FacilityGroup
              id="whakapapa-food-and-drink"
              title="Food & Drink"
              items={data.foodAndDrink}
              emptyLabel="No food & drink data available."
            />
          ) : null}
        </div>

        {data.visibility.lifts ? (
          <FacilityGroup
            id="whakapapa-lifts"
            title="Lifts"
            items={data.lifts}
            emptyLabel="No lift data available."
          />
        ) : null}

        {data.visibility.facilities ? (
          <FacilityGroup
            id="whakapapa-facilities"
            title="Facilities"
            items={data.facilities}
            emptyLabel="No facility data available."
          />
        ) : null}
      </div>

      {data.visibility.conditions ? (
        <article
          id="whakapapa-mountain-conditions"
          className="mt-3 rounded-md border border-border bg-card p-2"
        >
          <h3 className="text-sm font-semibold text-foreground">
            Mountain Conditions
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-xs text-muted-foreground">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pb-2 pr-4 font-medium">Location</th>
                  <th className="pb-2 pr-4 font-medium">Temp</th>
                  <th className="pb-2 pr-4 font-medium">Wind</th>
                  <th className="pb-2 pr-4 font-medium">Snow Base</th>
                  <th className="pb-2 pr-4 font-medium">24h</th>
                  <th className="pb-2 font-medium">7d</th>
                </tr>
              </thead>
              <tbody>
                {data.conditions.length > 0 ? (
                  data.conditions.map((condition) => (
                    <tr
                      key={condition.name}
                      className="border-t border-border"
                    >
                      <td className="py-2 pr-4 font-medium text-foreground">
                        {condition.name || "Unknown"}
                      </td>
                      <td className="py-2 pr-4">
                        {condition.temperature || "-"}
                      </td>
                      <td className="py-2 pr-4">{condition.wind || "-"}</td>
                      <td className="py-2 pr-4">{condition.snowBase || "-"}</td>
                      <td className="py-2 pr-4">
                        {condition.snowfall24h || "-"}
                      </td>
                      <td className="py-2">{condition.snowfall7d || "-"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td className="py-2 text-muted-foreground" colSpan={6}>
                      No condition data available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      ) : null}
    </section>
  );
}
