"use client";

import { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface LodgeOption {
  id: string;
  name: string;
  travelNote?: string | null;
}

// Shared lodge selector honouring the single-lodge presentation rule
// (docs/multi-lodge/decisions/ADR-002): when fewer than two lodges are
// offered it renders nothing and reports the sole lodge (or null) through
// onChange, so surrounding flows behave exactly as a single-lodge club.
export function LodgeSelect({
  lodges,
  value,
  onChange,
  label = "Lodge",
  id = "lodge-select",
  loading = false,
}: {
  lodges: LodgeOption[];
  value: string | null;
  onChange: (lodgeId: string | null) => void;
  label?: string;
  id?: string;
  // True while the lodge options are still being fetched. The sole-lodge /
  // default-selection normalisation must not run against an empty
  // still-loading list, or it clobbers a caller-provided initial selection
  // (e.g. a ?lodgeId= hub link, ADR-003) before the options arrive.
  loading?: boolean;
}) {
  useEffect(() => {
    if (loading) return;
    if (lodges.length < 2) {
      const sole = lodges[0]?.id ?? null;
      if (value !== sole) onChange(sole);
      return;
    }
    if (value === null) {
      onChange(lodges[0].id);
    }
  }, [lodges, value, onChange, loading]);

  if (lodges.length < 2) {
    return null;
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value ?? undefined}
        onValueChange={(next) => onChange(next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Choose a lodge" />
        </SelectTrigger>
        <SelectContent>
          {lodges.map((lodge) => (
            <SelectItem key={lodge.id} value={lodge.id}>
              {lodge.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Initial lodge context from a `?lodgeId=` URL parameter (ADR-003 hub
 * links), for a page's `useState` initialiser. Read synchronously on the
 * client so the page's very first data fetch is already lodge-filtered —
 * applying it in an effect creates an unfiltered-then-filtered request pair
 * whose responses can land out of order and show the wrong lodge's data.
 * During SSR there is no window and the value starts null, which is safe:
 * nothing lodge-dependent renders before the options load.
 */
export function initialLodgeIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("lodgeId");
}

/**
 * Fetch active lodges for the current user. `scope: "member"` returns only
 * lodges the member may book; `scope: "admin"` returns every lodge (admin
 * pages pass their own endpoint data instead where they already load it).
 */
export function useLodgeOptions(scope: "member" | "admin" = "member") {
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const url = scope === "admin" ? "/api/admin/lodges" : "/api/lodges";
    fetch(url)
      .then((response) => (response.ok ? response.json() : { lodges: [] }))
      .then((data: { lodges?: Array<LodgeOption & { active?: boolean }> }) => {
        if (cancelled) return;
        const rows = (data.lodges ?? []).filter(
          (lodge) => !("active" in lodge) || lodge.active !== false,
        );
        setLodges(rows.map(({ id, name, travelNote }) => ({ id, name, travelNote })));
      })
      .catch(() => {
        if (!cancelled) setLodges([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return { lodges, loading };
}
