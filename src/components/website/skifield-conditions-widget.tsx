"use client";

import { useEffect, useMemo, useState } from "react";

type SnowWidgetArea = {
  Name?: string;
  AreaName?: string;
  Title?: string;
  Status?: string;
  AreaStatus?: string;
  RoadStatus?: string;
  CurrentWeatherConditions?: string;
  Weather?: string;
  [key: string]: unknown;
};

type SnowWidgetPayload = {
  Type?: string;
  Areas?: SnowWidgetArea[];
  AreaStatus?: unknown;
  RoadStatus?: unknown;
  CurrentWeatherConditions?: unknown;
  _error?: string;
  upstreamStatus?: number;
};

function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function displayName(area: SnowWidgetArea, index: number) {
  return (
    valueText(area.Name) ||
    valueText(area.AreaName) ||
    valueText(area.Title) ||
    `Area ${index + 1}`
  );
}

function statusTone(status: string) {
  if (/open|operating|good/i.test(status)) {
    return "bg-emerald-100 text-emerald-800";
  }
  if (/closed|hold|limited|caution|chain|warning/i.test(status)) {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-slate-100 text-slate-700";
}

export function SkifieldConditionsWidget({ dataHash }: { dataHash?: string }) {
  const hash = dataHash?.trim();
  const hasValidHash = Boolean(hash && /^[a-f0-9]{32}$/.test(hash));
  const [data, setData] = useState<SnowWidgetPayload | null>(null);
  const [loading, setLoading] = useState(hasValidHash);
  const [error, setError] = useState("");

  useEffect(() => {
    const requestHash = hash;
    if (!hasValidHash || !requestHash) {
      setLoading(false);
      setData(null);
      return;
    }
    const validHash = requestHash;

    let active = true;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const response = await fetch(
          `/api/skifield-conditions?hash=${encodeURIComponent(validHash)}`,
          {
            method: "GET",
            cache: "no-store",
          },
        );
        const payload = (await response.json()) as SnowWidgetPayload;
        if (!active) {
          return;
        }
        setData(payload);
        setError(
          payload._error ||
            (response.ok ? "" : "Unable to load ski field conditions."),
        );
      } catch {
        if (active) {
          setData(null);
          setError("Unable to load ski field conditions.");
        }
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
  }, [hasValidHash, hash]);

  const areas = useMemo(
    () => (Array.isArray(data?.Areas) ? data.Areas : []),
    [data],
  );

  if (!hasValidHash) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <strong>Ski field conditions widget:</strong> a 32-character hex hash is
        required. Use{" "}
        <code className="font-mono">
          {"{{skifield-conditions:your-hash-here}}"}
        </code>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        Loading ski field conditions...
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Ski Field Conditions
          </h2>
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error}
        </p>
      ) : null}

      {areas.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {areas.map((area, index) => {
            const primaryStatus =
              valueText(area.Status) || valueText(area.AreaStatus);
            const roadStatus = valueText(area.RoadStatus);
            const weather =
              valueText(area.CurrentWeatherConditions) ||
              valueText(area.Weather);

            return (
              <article
                key={`${displayName(area, index)}-${index}`}
                className="rounded-md border border-slate-200 bg-slate-50 p-4"
              >
                <h3 className="text-sm font-semibold text-slate-900">
                  {displayName(area, index)}
                </h3>
                {primaryStatus ? (
                  <p className="mt-2">
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusTone(
                        primaryStatus,
                      )}`}
                    >
                      {primaryStatus}
                    </span>
                  </p>
                ) : null}
                <dl className="mt-3 space-y-2 text-xs text-slate-600">
                  {roadStatus ? (
                    <div>
                      <dt className="font-medium text-slate-700">Road</dt>
                      <dd>{roadStatus}</dd>
                    </div>
                  ) : null}
                  {weather ? (
                    <div>
                      <dt className="font-medium text-slate-700">Weather</dt>
                      <dd>{weather}</dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          No ski field condition data is currently available.
        </p>
      )}
    </section>
  );
}
