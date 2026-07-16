"use client";

import { useCallback, useEffect, useState } from "react";
import { CircleHelp, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  emptyWhakapapaCurlData,
  emptyWhakapapaSectionVisibility,
  type WhakapapaCurlData,
  type WhakapapaSectionVisibility,
} from "@/lib/whakapapa-report";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

const VISIBILITY_SECTIONS: {
  key: keyof WhakapapaSectionVisibility;
  label: string;
}[] = [
  { key: "roadStatus", label: "Road Status" },
  { key: "lifts", label: "Lifts" },
  { key: "facilities", label: "Facilities" },
  { key: "foodAndDrink", label: "Food & Drink" },
  { key: "conditions", label: "Mountain Conditions" },
];

type AdminMountainConditionsRecord = {
  source: string;
  payload: WhakapapaCurlData;
  fetchedAt: string;
  frozenUntil: string | null;
  updatedAt: string;
};

type ApiResponse = {
  record: AdminMountainConditionsRecord | null;
  message?: string;
  error?: string;
};

function formatDateTime(value: string | null | undefined) {
  if (!value) {
    return "Not set";
  }

  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function prettyJson(value: WhakapapaCurlData) {
  return JSON.stringify(value, null, 2);
}

export function MountainConditionsPanel() {
  const canEdit = useAdminAreaEditAccess("content");
  const [forbidden, setForbidden] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [rawJson, setRawJson] = useState("");
  const [record, setRecord] = useState<AdminMountainConditionsRecord | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [visibility, setVisibility] = useState<WhakapapaSectionVisibility>(
    emptyWhakapapaSectionVisibility(),
  );
  const [error, setError] = useState<string>("");
  // Sampled whenever the record is (re)loaded so the frozen check below can
  // stay pure during render (Date.now() must not run mid-render).
  const [recordSyncedAt, setRecordSyncedAt] = useState(0);

  const loadRecord = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/mountain-conditions");
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        throw new Error(body.error || "Failed to load mountain conditions");
      }

      const nextRecord = body.record;
      setRecord(nextRecord);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(nextRecord?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        nextRecord?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
    } catch (loadError) {
      setRecord(null);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(emptyWhakapapaCurlData()));
      setVisibility(emptyWhakapapaSectionVisibility());
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load mountain conditions",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecord();
  }, [loadRecord]);

  async function saveRecord() {
    setSaving(true);
    setError("");
    setForbidden(false);
    try {
      const response = await fetch("/api/admin/mountain-conditions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawJson }),
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        if (response.status === 403) setForbidden(true);
        throw new Error(body.error || "Failed to save mountain conditions");
      }

      setRecord(body.record);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(body.record?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        body.record?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
      toast.success(body.message || "Mountain conditions saved");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save mountain conditions",
      );
      toast.error("Mountain conditions save failed");
    } finally {
      setSaving(false);
    }
  }

  async function refreshFromUpstream() {
    setRefreshing(true);
    setError("");
    setForbidden(false);
    try {
      const response = await fetch("/api/admin/mountain-conditions", {
        method: "POST",
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        if (response.status === 403) setForbidden(true);
        throw new Error(body.error || "Failed to refresh mountain conditions");
      }

      setRecord(body.record);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(body.record?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        body.record?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
      toast.success(body.message || "Mountain conditions refreshed");
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : "Failed to refresh mountain conditions",
      );
      toast.error("Mountain conditions refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  async function saveVisibility() {
    setSavingVisibility(true);
    setError("");
    setForbidden(false);
    try {
      const response = await fetch("/api/admin/mountain-conditions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visibility }),
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok) {
        if (response.status === 403) setForbidden(true);
        throw new Error(body.error || "Failed to save section visibility");
      }

      setRecord(body.record);
      setRecordSyncedAt(Date.now());
      setRawJson(prettyJson(body.record?.payload ?? emptyWhakapapaCurlData()));
      setVisibility(
        body.record?.payload.visibility ?? emptyWhakapapaSectionVisibility(),
      );
      toast.success(body.message || "Section visibility saved");
    } catch (visibilityError) {
      setError(
        visibilityError instanceof Error
          ? visibilityError.message
          : "Failed to save section visibility",
      );
      toast.error("Section visibility save failed");
    } finally {
      setSavingVisibility(false);
    }
  }

  const frozenUntil = record?.frozenUntil ?? null;
  const isFrozen = Boolean(
    frozenUntil && new Date(frozenUntil).getTime() > recordSyncedAt,
  );

  if (loading) {
    return (
      <p className="text-sm text-slate-500">Loading mountain conditions...</p>
    );
  }

  return (
    <>
      {!canEdit ? (
        <AdminViewOnlyNotice className="mb-4">
          Your admin role can view mountain conditions but cannot change them.
        </AdminViewOnlyNotice>
      ) : null}
      {forbidden ? <AdminForbiddenSaveNotice className="mb-4" /> : null}
      <div className="mb-4 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setHelpOpen(true)}
          aria-label="Mountain Conditions help"
          title="Mountain Conditions help"
        >
          <CircleHelp className="h-4 w-4" />
        </Button>
        <ViewOnlyActionButton
          canEdit={canEdit}
          type="button"
          variant="outline"
          onClick={refreshFromUpstream}
          disabled={refreshing || saving}
        >
          {refreshing ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          {refreshing ? "Refreshing..." : "Update from upstream"}
        </ViewOnlyActionButton>
      </div>

      {error ? (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle>Section visibility</CardTitle>
          <CardDescription>
            Choose which articles appear on the public Whakapapa Conditions
            widget. Unticked sections are hidden from visitors.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {VISIBILITY_SECTIONS.map((section) => (
              <label
                key={section.key}
                htmlFor={`visibility-${section.key}`}
                className="flex items-center gap-3 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700"
              >
                <Checkbox
                  id={`visibility-${section.key}`}
                  checked={visibility[section.key]}
                  onCheckedChange={(checked) =>
                    setVisibility((current) => ({
                      ...current,
                      [section.key]: checked,
                    }))
                  }
                  disabled={savingVisibility || !canEdit}
                />
                {section.label}
              </label>
            ))}
          </div>

          <div className="flex justify-end">
            <ViewOnlyActionButton
              canEdit={canEdit}
              type="button"
              onClick={saveVisibility}
              disabled={savingVisibility}
            >
              {savingVisibility ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {savingVisibility ? "Saving..." : "Save visibility"}
            </ViewOnlyActionButton>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle>Raw JSON</CardTitle>
              <CardDescription>
                Edit the stored Whakapapa JSON payload directly, then save it to
                pause automatic refreshes for 12 hours.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              {isFrozen ? (
                <Badge className="border-amber-200 bg-amber-100 text-amber-800">
                  Auto refresh paused
                </Badge>
              ) : (
                <Badge variant="outline">Auto refresh active</Badge>
              )}
              <Badge variant="outline">
                Last fetched: {formatDateTime(record?.fetchedAt)}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={rawJson}
            onChange={(event) => setRawJson(event.target.value)}
            className="min-h-[520px] font-mono text-xs"
            spellCheck={false}
            readOnly={!canEdit}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
            <div className="space-y-1">
              <p>Frozen until: {formatDateTime(frozenUntil)}</p>
              <p>Last updated in DB: {formatDateTime(record?.updatedAt)}</p>
            </div>
            <ViewOnlyActionButton
              canEdit={canEdit}
              type="button"
              onClick={saveRecord}
              disabled={saving || refreshing}
            >
              {saving ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "Saving..." : "Save"}
            </ViewOnlyActionButton>
          </div>
        </CardContent>
      </Card>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Mountain Conditions help</DialogTitle>
            <DialogDescription>
              This screen edits the cached Whakapapa JSON payload that powers
              the public mountain conditions display.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm leading-6 text-slate-700">
            <p>
              <i>
                <b>Save</b>
              </i>{" "}
              stores the raw JSON from the editor into the database and pauses
              automatic upstream updates for 12 hours.
            </p>
            <p>
              <i>
                <b>Update from upstream</b>
              </i>{" "}
              ignores the freeze window, fetches the latest JSON from Whakapapa,
              stores it in the database, and resumes normal automatic refresh
              behaviour.
            </p>
            <p>
              The public page uses the same cached data, so changes here will
              flow through to the website immediately after saving or
              refreshing.
            </p>
            <p>
              <i>
                <b>Section visibility</b>
              </i>{" "}
              controls which articles appear on the public widget. Unticked
              sections are hidden from visitors, and the choices are preserved
              across automatic and manual upstream refreshes.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
