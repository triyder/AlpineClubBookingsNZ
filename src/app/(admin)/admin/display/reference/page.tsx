"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { MODULE_DEFINITIONS } from "@/config/modules";
import {
  listDisplayConditions,
  type DisplayConditionDefinition,
  type DisplayConditionFamily,
} from "@/lib/lodge-display/conditions";
import { listDisplayModules } from "@/lib/lodge-display/module-registry";
import {
  listDisplayCssTokens,
  type DisplayCssToken,
} from "@/lib/lodge-display/css-tokens";

// LTV-034 (#80) — read-only Modules / Conditions / CSS-tokens reference (ADR-003
// §3, "Navigation & terminology"). Everything on this page is presentation over
// three CLIENT-SAFE registries: `listDisplayModules()`, `listDisplayConditions()`,
// and `listDisplayCssTokens()`. The only server call is the conditions status
// endpoint, which computes the "true right now for this lodge" indicator from a
// freshly built DisplayState; it is refreshed by a button, never polled, so the
// indicator is explicitly point-in-time.

// The display palette values are the constants `display.css` cascades from
// `.display-shell`. That stylesheet is scoped to the /display route and is NOT
// loaded in the admin bundle, so the swatches read the values from this lookup
// rather than resolving `var(--display-*)` (which would be undefined here). Brand
// tokens are per-club and resolve only against the live club theme, so they are
// shown without a swatch (see the CSS-tokens card note) — the pragmatic split the
// task allows.
const DISPLAY_PALETTE_SWATCHES: Record<string, string> = {
  "--display-ink": "#eef8fa",
  "--display-accent": "#43c2d4",
  "--display-muted": "#8fb2ba",
  "--display-panel": "rgba(255, 255, 255, 0.05)",
  "--display-line": "rgba(255, 255, 255, 0.12)",
  "--display-arriving": "#4bc48d",
  "--display-departing": "#e6a84f",
  "--display-group": "#b79bff",
};

const CONDITION_FAMILY_ORDER: DisplayConditionFamily[] = [
  "core",
  "occupancy",
  "content",
  "capability",
];

const CONDITION_FAMILY_LABEL: Record<DisplayConditionFamily, string> = {
  core: "Core",
  occupancy: "Occupancy",
  content: "Content",
  capability: "Capability",
};

interface LodgeOption {
  id: string;
  name: string;
}

interface ConditionStatus {
  lodgeId: string;
  lodgeName: string;
  values: Record<string, boolean>;
}

function InlineCode({ children }: { children: string }) {
  return (
    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs break-all">
      {children}
    </code>
  );
}

function CopyToken({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard.writeText(token).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="bg-muted hover:bg-accent inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs break-all"
    >
      {token}
      <span className="text-muted-foreground">{copied ? "✓" : "⧉"}</span>
    </button>
  );
}

// "needs Chores — hides without it" / "uses Bed allocation — degrades without
// it", derived from the module labels in MODULE_DEFINITIONS so the phrasing
// tracks the club-module names automatically.
function dependencyPhrase(
  dependencies: readonly string[],
  mode: "degrades" | "hides"
): string | null {
  if (dependencies.length === 0) return null;
  const labels = dependencies.map(
    (key) => MODULE_DEFINITIONS[key as keyof typeof MODULE_DEFINITIONS]?.label ?? key
  );
  const list = labels.join(", ");
  return mode === "hides"
    ? `needs ${list} — hides without it`
    : `uses ${list} — degrades without it`;
}

export default function AdminDisplayReferencePage() {
  const modules = listDisplayModules();
  const conditions = listDisplayConditions();
  const cssTokens = listDisplayCssTokens();

  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [lodgeId, setLodgeId] = useState<string>("");
  const [status, setStatus] = useState<ConditionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async (selectedLodgeId: string) => {
    setLoading(true);
    setError(null);
    const query = selectedLodgeId ? `?lodgeId=${encodeURIComponent(selectedLodgeId)}` : "";
    const response = await fetch(`/api/admin/display/reference/conditions${query}`);
    if (!response.ok) {
      setError("Could not load the live condition status.");
      setLoading(false);
      return;
    }
    const body = (await response.json()) as {
      lodgeId: string;
      lodgeName: string;
      conditions: Array<{ name: string; value: boolean }>;
    };
    const values: Record<string, boolean> = {};
    for (const entry of body.conditions) values[entry.name] = entry.value;
    setStatus({ lodgeId: body.lodgeId, lodgeName: body.lodgeName, values });
    setLoading(false);
  }, []);

  // Best-effort lodge list (multi-lodge clubs only). A single-lodge club has no
  // lodges endpoint; the status endpoint then resolves the club default.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch("/api/admin/lodges").catch(() => null);
      if (res?.ok && !cancelled) {
        const body = (await res.json()) as {
          lodges?: Array<{ id: string; name: string; active?: boolean }>;
        };
        const active = (body.lodges ?? []).filter((lodge) => lodge.active !== false);
        setLodges(active.map((lodge) => ({ id: lodge.id, name: lodge.name })));
      }
      if (!cancelled) void refreshStatus("");
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshStatus]);

  function onSelectLodge(next: string) {
    setLodgeId(next);
    void refreshStatus(next);
  }

  const conditionsByFamily = CONDITION_FAMILY_ORDER.map((family) => ({
    family,
    entries: conditions.filter((c) => c.family === family),
  })).filter((group) => group.entries.length > 0);

  const paletteTokens = cssTokens.filter((t) => t.family === "display");
  const brandTokens = cssTokens.filter((t) => t.family === "brand");

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Reference</h1>
        <p className="text-muted-foreground">
          The lobby display vocabulary: the modules you can embed, the conditions
          that gate areas, and the CSS tokens you can reference in authored CSS.
          Read-only — nothing here changes any setting.
        </p>
      </div>

      {/* Modules ------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-muted-foreground text-sm">
            Each module is embedded in a Layout or Template by its token. CSS
            hooks are the stable class names you may target from authored CSS.
          </p>
          {modules.map((module) => {
            const phrase = dependencyPhrase(module.dependencies, module.dependencyMode);
            return (
              <div
                key={module.name}
                className="space-y-2 border-b pb-4 last:border-b-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{module.label}</span>
                  <InlineCode>{module.name}</InlineCode>
                  <CopyToken token={module.embedToken} />
                </div>
                <p className="text-muted-foreground text-sm">{module.description}</p>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Dependencies:</span>
                  {phrase ? (
                    <span>{phrase}</span>
                  ) : (
                    <span className="text-muted-foreground">none</span>
                  )}
                </div>
                {module.contributes.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Contributes:</span>
                    {module.contributes.map((name) => (
                      <InlineCode key={name}>{name}</InlineCode>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="text-muted-foreground">CSS hooks:</span>
                  {module.cssHooks.map((hook) => (
                    <InlineCode key={hook}>{`.${hook}`}</InlineCode>
                  ))}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Conditions -------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>Conditions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-end gap-3">
            <p className="text-muted-foreground flex-1 text-sm">
              Conditions gate any area (show/hide) and drive rotator eligibility.
              The live indicator shows whether each holds{" "}
              <span className="font-medium">right now</span> for the selected
              lodge — a point-in-time snapshot, refreshed by the button, never
              polled.
            </p>
            {lodges.length > 1 && (
              <div className="space-y-1">
                <Label htmlFor="reference-lodge">Lodge</Label>
                <select
                  id="reference-lodge"
                  className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                  value={lodgeId}
                  onChange={(event) => onSelectLodge(event.target.value)}
                >
                  <option value="">Club default</option>
                  {lodges.map((lodge) => (
                    <option key={lodge.id} value={lodge.id}>
                      {lodge.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <Button
              variant="outline"
              onClick={() => void refreshStatus(lodgeId)}
              disabled={loading}
            >
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
          <p className="text-sm">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : status ? (
              <span className="text-muted-foreground">
                Live status for <span className="font-medium">{status.lodgeName}</span>.
              </span>
            ) : (
              <span className="text-muted-foreground">Loading live status…</span>
            )}
          </p>

          {conditionsByFamily.map((group) => (
            <div key={group.family} className="space-y-2">
              <h3 className="text-sm font-semibold">
                {CONDITION_FAMILY_LABEL[group.family]}
              </h3>
              <div className="space-y-3">
                {group.entries.map((condition: DisplayConditionDefinition) => {
                  const value = status?.values[condition.name];
                  return (
                    <div
                      key={condition.name}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1"
                    >
                      <InlineCode>{condition.name}</InlineCode>
                      {value === undefined ? (
                        <Badge variant="outline">—</Badge>
                      ) : value ? (
                        <Badge variant="success">● true now</Badge>
                      ) : (
                        <Badge variant="secondary">○ false now</Badge>
                      )}
                      <span className="text-muted-foreground w-full text-sm sm:w-auto sm:flex-1">
                        {condition.description}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* CSS tokens -------------------------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle>CSS tokens</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-muted-foreground text-sm">
            Custom properties you may reference as <InlineCode>var(--…)</InlineCode>{" "}
            in a Layout&rsquo;s or Template&rsquo;s CSS.
          </p>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Display palette</h3>
            <p className="text-muted-foreground text-sm">
              The board&rsquo;s own dark palette — theme-independent and always
              defined.
            </p>
            <div className="space-y-2">
              {paletteTokens.map((token: DisplayCssToken) => (
                <div key={token.name} className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden
                    className="inline-block h-4 w-4 shrink-0 rounded border"
                    style={{ background: DISPLAY_PALETTE_SWATCHES[token.name] }}
                  />
                  <InlineCode>{token.name}</InlineCode>
                  <span className="text-muted-foreground text-sm">
                    {token.description}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Club brand</h3>
            <p className="text-muted-foreground text-sm">
              The club theme&rsquo;s colours and fonts, injected read-only from the
              live theme. Values are per-club, so no swatch is shown here.
            </p>
            <div className="space-y-2">
              {brandTokens.map((token: DisplayCssToken) => (
                <div key={token.name} className="flex flex-wrap items-center gap-3">
                  <InlineCode>{token.name}</InlineCode>
                  <span className="text-muted-foreground text-sm">
                    {token.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
