"use client";

import { useEffect, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface InternetBankingSettings {
  holdBedSlots: boolean;
  holdDays: number;
  minimumDaysBeforeCheckIn: number;
}

interface ModuleState {
  xeroIntegrationEnabled: boolean;
  internetBankingPaymentsEnabled: boolean;
  ready: boolean;
}

export function InternetBankingSettingsPanel() {
  const [settings, setSettings] = useState<InternetBankingSettings | null>(null);
  const [moduleState, setModuleState] = useState<ModuleState | null>(null);
  const [holdPolicySummary, setHoldPolicySummary] = useState("");
  const [xeroBehaviour, setXeroBehaviour] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/internet-banking-settings", {
        credentials: "same-origin",
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseBody?.error ?? "Failed to load Internet Banking settings");
      }
      setSettings(responseBody.settings);
      setModuleState(responseBody.moduleState);
      setHoldPolicySummary(responseBody.holdPolicySummary ?? "");
      setXeroBehaviour(responseBody.xeroBehaviour ?? "");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load Internet Banking settings",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function update(patch: Partial<InternetBankingSettings>) {
    setSettings((current) => (current ? { ...current, ...patch } : current));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/internet-banking-settings", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const responseBody = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(responseBody?.error ?? "Failed to save Internet Banking settings");
      }
      setSettings(responseBody.settings);
      setHoldPolicySummary(responseBody.holdPolicySummary ?? "");
      toast.success("Internet Banking settings saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save Internet Banking settings",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading || !settings || !moduleState) {
    return <p className="text-sm text-slate-500">Loading Internet Banking settings</p>;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant={moduleState.ready ? "default" : "secondary"}>
            {moduleState.ready ? "Module Ready" : "Module Not Ready"}
          </Badge>
          <Badge variant={moduleState.xeroIntegrationEnabled ? "outline" : "secondary"}>
            Xero {moduleState.xeroIntegrationEnabled ? "on" : "off"}
          </Badge>
          <Badge variant={moduleState.internetBankingPaymentsEnabled ? "outline" : "secondary"}>
            Internet Banking {moduleState.internetBankingPaymentsEnabled ? "on" : "off"}
          </Badge>
        </div>
        <p className="text-sm text-slate-600">{xeroBehaviour}</p>
        <p className="text-sm text-slate-600">{holdPolicySummary}</p>
      </div>

      <label className="flex items-start gap-3">
        <Checkbox
          className="mt-0.5"
          checked={settings.holdBedSlots}
          onCheckedChange={(checked) => update({ holdBedSlots: checked === true })}
        />
        <span className="text-sm">
          <span className="font-medium text-slate-900">
            Hold beds while Internet Banking payment is pending
          </span>
          <span className="block text-slate-600">
            When on, bookings are confirmed immediately and released if Xero has
            not reconciled payment before the hold expires.
          </span>
        </span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="ib-hold-days">Hold duration</Label>
          <Input
            id="ib-hold-days"
            className="mt-1"
            type="number"
            min={1}
            max={30}
            value={settings.holdDays}
            onChange={(event) =>
              update({ holdDays: Number.parseInt(event.target.value || "0", 10) })
            }
          />
        </div>
        <div>
          <Label htmlFor="ib-minimum-days">Minimum lead time before check-in</Label>
          <Input
            id="ib-minimum-days"
            className="mt-1"
            type="number"
            min={0}
            max={365}
            value={settings.minimumDaysBeforeCheckIn}
            onChange={(event) =>
              update({
                minimumDaysBeforeCheckIn: Number.parseInt(event.target.value || "0", 10),
              })
            }
          />
        </div>
      </div>

      <Button onClick={save} disabled={saving}>
        <Save className="h-4 w-4" />
        {saving ? "Saving" : "Save Settings"}
      </Button>
    </div>
  );
}
