"use client";

import { useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { ArrowRightLeft, Download, Upload, AlertTriangle } from "lucide-react";

import { isFullAdmin } from "@/lib/access-roles";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CONFIG_TRANSFER_CATEGORIES,
  type ConfigTransferCategory,
} from "@/lib/config-transfer/manifest";

// Full-admin Configuration Export & Import page. Export selected categories to a
// portable zip; import a bundle via a mandatory dry-run before applying (the
// server takes a database backup and never deletes). See docs/config-transfer.

const CATEGORY_LABELS: Record<ConfigTransferCategory, string> = {
  "site-content": "Site content & appearance",
  "club-settings": "Club settings",
  "lodge-config": "Lodge configuration",
  committee: "Committee (roles)",
  induction: "Induction checklists",
  "xero-config": "Xero configuration",
};

type PlanItem = {
  entity: string;
  key: string;
  action: "create" | "update" | "unchanged";
  changedFields?: string[];
};
type CategoryPlan = {
  category: ConfigTransferCategory;
  items: PlanItem[];
  warnings: string[];
};
type ImportPlan = {
  categories: CategoryPlan[];
  fingerprint: string;
  doorCodesIncluded: boolean;
  xero: { sourceTenantId: string | null; targetTenantId: string | null; mismatch: boolean };
  summary: { create: number; update: number; unchanged: number };
};

export default function ConfigTransferPage() {
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  const [selected, setSelected] = useState<Set<ConfigTransferCategory>>(
    () => new Set(["site-content", "club-settings", "lodge-config"]),
  );
  const [includeDoorCodes, setIncludeDoorCodes] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const canExport = useMemo(() => selected.size > 0, [selected]);

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-white p-6 text-sm text-muted-foreground">
        Configuration Export &amp; Import is available to full administrators only.
      </div>
    );
  }

  function toggle(category: ConfigTransferCategory) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  async function runExport() {
    setExporting(true);
    setExportError(null);
    try {
      const res = await fetch("/api/admin/config-transfer/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          categories: [...selected],
          includeDoorCodes,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Export failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `config-transfer-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  async function runPreview() {
    if (!file) return;
    setPlanning(true);
    setImportError(null);
    setApplied(null);
    setPlan(null);
    try {
      const form = new FormData();
      form.append("bundle", file);
      const res = await fetch("/api/admin/config-transfer/plan", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as
        | { plan?: ImportPlan; error?: string }
        | null;
      if (!res.ok || !data?.plan) {
        throw new Error(data?.error ?? "Could not read the bundle.");
      }
      setPlan(data.plan);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setPlanning(false);
    }
  }

  async function runApply() {
    if (!file || !plan) return;
    setApplying(true);
    setImportError(null);
    try {
      const form = new FormData();
      form.append("bundle", file);
      form.append("expectedFingerprint", plan.fingerprint);
      const res = await fetch("/api/admin/config-transfer/apply", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as
        | { result?: { totals: Record<string, number> }; error?: string }
        | null;
      if (!res.ok || !data?.result) {
        throw new Error(data?.error ?? "Apply failed.");
      }
      const t = data.result.totals;
      setApplied(
        `Applied: ${t.created} created, ${t.updated} updated, ${t.unchanged} unchanged.`,
      );
      setPlan(null);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900">
          <ArrowRightLeft className="h-6 w-6" />
          Configuration Export &amp; Import
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Move configuration, site content, and lodge setup between instances as a
          portable file. This is not a database backup: importing never deletes,
          so restoring a bundle will not remove anything added since it was
          exported. Members and transactional data are never included.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4 w-4" />
            Export
          </CardTitle>
          <CardDescription>
            Choose the categories to include and download a bundle.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {CONFIG_TRANSFER_CATEGORIES.map((category) => (
              <label
                key={category}
                className="flex items-center gap-2 text-sm"
                htmlFor={`cat-${category}`}
              >
                <Checkbox
                  id={`cat-${category}`}
                  checked={selected.has(category)}
                  onCheckedChange={() => toggle(category)}
                />
                {CATEGORY_LABELS[category]}
              </label>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm" htmlFor="door-codes">
            <Checkbox
              id="door-codes"
              checked={includeDoorCodes}
              onCheckedChange={(v) => setIncludeDoorCodes(v === true)}
            />
            Include lodge door codes (physical-access information)
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={() => void runExport()} disabled={!canExport || exporting}>
              {exporting ? "Exporting…" : "Export bundle"}
            </Button>
          </div>
          {exportError && (
            <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">
              {exportError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4 w-4" />
            Import
          </CardTitle>
          <CardDescription>
            Upload a bundle and preview the changes. Nothing is applied until you
            confirm; the server takes a database backup before applying.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <input
            type="file"
            accept=".zip,application/zip"
            className="block text-sm"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setPlan(null);
              setApplied(null);
              setImportError(null);
            }}
          />
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => void runPreview()}
              disabled={!file || planning}
            >
              {planning ? "Reading…" : "Preview (dry-run)"}
            </Button>
            <Button
              onClick={() => void runApply()}
              disabled={!plan || applying}
            >
              {applying ? "Applying…" : "Apply import"}
            </Button>
          </div>

          {plan && (
            <div className="space-y-3 rounded-md border p-4 text-sm">
              <p className="font-medium">
                Plan: {plan.summary.create} new, {plan.summary.update} updated,{" "}
                {plan.summary.unchanged} unchanged.
              </p>
              {plan.doorCodesIncluded && (
                <p className="text-amber-800">
                  This bundle includes door codes.
                </p>
              )}
              {plan.xero.mismatch && (
                <p className="flex items-center gap-2 text-amber-800">
                  <AlertTriangle className="h-4 w-4" />
                  Xero config came from a different connected org — verify before
                  applying.
                </p>
              )}
              {plan.categories.map((cat) => (
                <div key={cat.category}>
                  <p className="font-medium">{CATEGORY_LABELS[cat.category]}</p>
                  <ul className="ml-4 list-disc text-muted-foreground">
                    {cat.items.slice(0, 50).map((item) => (
                      <li key={`${item.entity}:${item.key}`}>
                        {item.action} — {item.entity} “{item.key}”
                        {item.changedFields?.length
                          ? ` (${item.changedFields.join(", ")})`
                          : ""}
                      </li>
                    ))}
                  </ul>
                  {cat.warnings.map((w) => (
                    <p key={w} className="text-amber-800">
                      {w}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}

          {applied && (
            <p className="rounded-md bg-green-50 p-2 text-sm text-green-700">
              {applied}
            </p>
          )}
          {importError && (
            <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">
              {importError}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
