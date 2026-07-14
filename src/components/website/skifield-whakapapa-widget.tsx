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
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-emerald-800 bg-emerald-100">
        {status}
      </span>
    );
  }

  if (normalized === "closed") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-red-800 bg-red-100">
        {status}
      </span>
    );
  }

  if (normalized === "coming soon") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100">
        {status}
      </span>
    );
  }

  if (normalized === "limited availability") {
    return (
      <span className="flex w-full justify-center rounded-full px-2 py-1 text-xs font-medium text-amber-800 bg-amber-100">
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
      className="rounded-md border border-slate-200 bg-slate-50 p-2"
    >
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {items.length > 0 ? (
        <div
          className={`mt-2 flex flex-wrap gap-2 ${title.replace(/\s+/g, "-").toLowerCase()}-status-container`}
        >
          {items.map((item) => (
            <div
              key={`${item.name}-${item.status}`}
              className={`flex flex-col gap-1 rounded-md border border-slate-200 bg-white p-2 ${title.replace(/\s+/g, "-").toLowerCase()}-status-item`}
            >
              <span
                className={`text-xs font-medium text-slate-800 ${title.replace(/\s+/g, "-").toLowerCase()}-status-description`}
              >
                {item.name || "Unknown"}
              </span>
              <StatusCell status={item.status} />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-slate-500">{emptyLabel}</p>
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
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
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
    ? "bg-emerald-100 text-emerald-800"
    : data.roadStatus.status
      ? "bg-amber-100 text-amber-800"
      : "bg-slate-100 text-slate-700";

  return (
    <section
      id="conditions"
      className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm sm:p-4"
    >
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            Whakapapa Conditions
          </h2>
          <p className="text-xs text-slate-500">Updated: {formattedUpdated}</p>
        </div>
        {stale ? (
          <span className="inline-flex rounded-full bg-amber-100 px-2 py-1 text-xs font-medium text-amber-800">
            Showing cached data
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error}
        </p>
      ) : null}

      <div className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          {data.visibility.roadStatus ? (
            <article
              id="whakapapa-road-status"
              className="rounded-md border border-slate-200 bg-slate-50 p-2"
            >
              <h3 className="text-sm font-semibold text-slate-900">
                Road Status
              </h3>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="sm:flex-1">
                  <div className="text-xs text-slate-700">
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
                  <dl className="space-y-2 text-xs text-slate-600 sm:flex-1">
                    {data.roadStatus.wheelRequirements ? (
                      <div>
                        <dt className="font-medium text-slate-700">
                          Wheel requirements
                        </dt>
                        <dd>{data.roadStatus.wheelRequirements}</dd>
                      </div>
                    ) : null}
                    {data.roadStatus.roadContent ? (
                      <div>
                        <dt className="font-medium text-slate-700">
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
          className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            Mountain Conditions
          </h3>
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full text-left text-xs text-slate-700">
              <thead className="text-slate-500">
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
                      className="border-t border-slate-200"
                    >
                      <td className="py-2 pr-4 font-medium text-slate-800">
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
                    <td className="py-2 text-slate-500" colSpan={6}>
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
