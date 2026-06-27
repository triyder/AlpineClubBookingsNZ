"use client";

import { useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface LodgeSettingsResponse {
  capacity: number | null;
  clubConfigCapacity: number;
}

export function LodgeCapacityCard() {
  const [clubConfigCapacity, setClubConfigCapacity] = useState<number | null>(
    null,
  );
  const [value, setValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/lodge-settings", {
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Failed to load lodge capacity");
      const body = (await response.json()) as LodgeSettingsResponse;
      setClubConfigCapacity(body.clubConfigCapacity);
      setValue(body.capacity === null ? "" : String(body.capacity));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load lodge capacity");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setSavedMessage("");

    const trimmed = value.trim();
    let capacity: number | null = null;
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        setError("Enter a whole number greater than zero, or leave blank to use the default.");
        setSaving(false);
        return;
      }
      capacity = parsed;
    }

    try {
      const response = await fetch("/api/admin/lodge-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capacity }),
      });
      if (!response.ok) throw new Error("Failed to save lodge capacity");
      const body = (await response.json()) as LodgeSettingsResponse;
      setClubConfigCapacity(body.clubConfigCapacity);
      setValue(body.capacity === null ? "" : String(body.capacity));
      setSavedMessage(
        capacity === null
          ? "Lodge capacity reset to the club default."
          : "Lodge capacity saved.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge capacity");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Lodge capacity</CardTitle>
        <CardDescription>
          The total number of guests the lodge can hold. This is used as the
          fallback capacity for bookings. When the Bed Allocation module is on
          and beds are configured, the live bed count is used instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {(error || savedMessage) && (
          <div
            className={
              error
                ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                : "rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
            }
          >
            {error || savedMessage}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="lodge-capacity">Capacity (beds/guests)</Label>
            <Input
              id="lodge-capacity"
              type="number"
              min={1}
              inputMode="numeric"
              className="w-40"
              placeholder={
                clubConfigCapacity === null
                  ? "Default"
                  : `Default: ${clubConfigCapacity}`
              }
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setSavedMessage("");
              }}
              disabled={loading || saving}
            />
          </div>
          <Button type="button" onClick={() => void save()} disabled={loading || saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save
          </Button>
        </div>

        <p className="text-xs text-slate-500">
          Leave blank to use the club default
          {clubConfigCapacity === null ? "" : ` (${clubConfigCapacity})`}.
        </p>
      </CardContent>
    </Card>
  );
}
