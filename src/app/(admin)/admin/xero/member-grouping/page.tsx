"use client";

import type { AgeTier } from "@prisma/client";
import { useCallback, useEffect, useState } from "react";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ViewOnlyActionButton,
  AdminViewOnlyNotice,
} from "@/components/admin/view-only-action";
import {
  useAdminAreaEditAccess,
  useAdminAreaViewAccess,
} from "@/hooks/use-admin-area-edit-access";
import { formatAgeTierName } from "@/lib/use-age-tier-options";

type GroupingMode = "NONE" | "MEMBERSHIP_TYPE" | "MEMBERSHIP_TYPE_AND_AGE";
type RuleKind = "MANAGED" | "ACCEPTED";
const ANY = "__any__";

type Rule = {
  id: string;
  membershipTypeId: string | null;
  membershipTypeName: string | null;
  ageTier: AgeTier | null;
  mode: RuleKind;
  groupId: string;
  groupName: string | null;
  isActive: boolean;
  sortOrder: number;
};

type Config = {
  mode: GroupingMode;
  rules: Rule[];
  groups: Array<{ id: string; name: string; contactCount: number }>;
  lastRefreshedAt: string | null;
  membershipTypes: Array<{ id: string; name: string }>;
  ageTiers: AgeTier[];
};

type DiffEntry = {
  memberId: string;
  memberName: string;
  ageTier: AgeTier;
  addGroupId: string | null;
  managedGroup: { id: string; name: string | null } | null;
  removeGroupIds: string[];
};

type InformationalEntry = {
  memberId: string;
  memberName: string;
  ageTier: AgeTier;
  unexpectedManagedGroupIds: string[];
};

type Snapshot = {
  mode: GroupingMode;
  cacheReady: boolean;
  lastRefreshedAt: string | null;
  mismatchCount: number;
  addCount: number;
  removeCount: number;
  estimatedXeroCalls: number;
  membersConsidered: number;
  skippedNoContact: Array<{ memberId: string; memberName: string }>;
  mismatches: DiffEntry[];
  informationalCount: number;
  informational: InformationalEntry[];
};

const MODE_HELP: Record<GroupingMode, string> = {
  NONE: "None: existing Xero groups are left untouched. The system never adds or removes a contact's group membership, and never calls Xero.",
  MEMBERSHIP_TYPE: "Membership Type: only membership-type rules apply. Age-tier rules are shown but ignored.",
  MEMBERSHIP_TYPE_AND_AGE: "Membership Type + Age: the most specific rule wins — type+tier beats type-only beats tier-only.",
};

async function api(body: unknown) {
  const res = await fetch("/api/admin/xero/member-grouping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? "Request failed");
  return json;
}

export default function XeroMemberGroupingPage() {
  // Mode/rule/bulk controls need finance:edit; the dry-run is read-only and
  // matches the API's finance:view guard (E1 pattern, #1934 review).
  const canEdit = useAdminAreaEditAccess("finance");
  const canView = useAdminAreaViewAccess("finance");
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [resyncState, setResyncState] = useState<{
    status: string;
    nextCursorMemberId: string | null;
    haltedByDailyLimit: boolean;
    failures: Array<{ memberId: string; error: string }>;
  } | null>(null);

  // New-rule draft
  const [draftTypeId, setDraftTypeId] = useState<string>(ANY);
  const [draftTier, setDraftTier] = useState<string>(ANY);
  const [draftMode, setDraftMode] = useState<RuleKind>("MANAGED");
  const [draftGroupId, setDraftGroupId] = useState<string>("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/xero/member-grouping");
      if (!res.ok) throw new Error("Failed to load configuration");
      setConfig(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (body: unknown, after?: (json: unknown) => void) => {
      setBusy(true);
      setError(null);
      try {
        const json = await api(body);
        if (after) after(json);
        else setConfig(json);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const groupName = useCallback(
    (id: string) => config?.groups.find((g) => g.id === id)?.name ?? id,
    [config],
  );

  type BulkResult = {
    processed: number;
    added: number;
    removed: number;
    failed: number;
    done: boolean;
    haltedByDailyLimit: boolean;
    nextCursorMemberId: string | null;
    failures: Array<{ memberId: string; error: string }>;
  };

  const runBulkResync = useCallback(
    (afterMemberId?: string) => {
      void run(
        {
          action: "bulk-resync",
          confirmDryRunReviewed: true,
          ...(afterMemberId ? { afterMemberId } : {}),
        },
        (json) => {
          const r = (json as { result: BulkResult }).result;
          setResyncState({
            status: `Processed ${r.processed} (added ${r.added}, removed ${r.removed}, failed ${r.failed}).`,
            nextCursorMemberId: r.done ? null : r.nextCursorMemberId,
            haltedByDailyLimit: r.haltedByDailyLimit,
            failures: r.failures,
          });
          void load();
        },
      );
    },
    [load, run],
  );

  if (!config) {
    return (
      <div className="space-y-4">
        <AdminPageHeader title="Xero member grouping" description="Loading…" />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Xero member grouping"
        description="Choose how members are auto-sorted into Xero contact groups, and manage the grouping rules."
      />
      {!canEdit ? <AdminViewOnlyNotice /> : null}
      {error ? <p className="text-sm text-danger">{error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Grouping mode</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(Object.keys(MODE_HELP) as GroupingMode[]).map((mode) => (
            <label key={mode} className="flex items-start gap-3">
              <input
                type="radio"
                name="grouping-mode"
                className="mt-1"
                checked={config.mode === mode}
                disabled={!canEdit || busy}
                onChange={() => void run({ action: "set-mode", mode })}
              />
              <span className="text-sm">
                <span className="font-medium">
                  {mode === "NONE" ? "None" : mode === "MEMBERSHIP_TYPE" ? "Membership Type" : "Membership Type + Age"}
                </span>
                <span className="block text-muted-foreground">{MODE_HELP[mode]}</span>
              </span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            Changing the mode or a rule never re-groups existing members. Members re-group on their
            next trigger (age change, membership-type change, cron age-up, contact link) or when you
            run the bulk re-sync below.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Grouping rules</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            {config.lastRefreshedAt
              ? `Xero group list cached ${new Date(config.lastRefreshedAt).toLocaleString("en-NZ")}.`
              : "The Xero contact-group cache has not been refreshed yet — refresh it from the Xero Sync page."}
          </p>

          {config.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            <div className="space-y-2">
              {config.rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{rule.groupName ?? groupName(rule.groupId)}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{rule.mode}</span>
                      {!rule.isActive ? (
                        <span className="rounded bg-slate-200 px-1.5 py-0.5 text-xs">inactive</span>
                      ) : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {rule.membershipTypeName ?? "Any type"} · {rule.ageTier ? formatAgeTierName(rule.ageTier) : "Any age"}
                      {config.mode === "MEMBERSHIP_TYPE" && rule.ageTier
                        ? " · (inert in Membership Type mode)"
                        : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run({ action: "toggle-rule", id: rule.id, isActive: !rule.isActive })
                      }
                    >
                      {rule.isActive ? "Deactivate" : "Activate"}
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      title="Members already in this group will not be removed."
                      onClick={() => {
                        if (
                          window.confirm(
                            "Delete this rule? Members already in this group will NOT be removed from it.",
                          )
                        ) {
                          void run({ action: "delete-rule", id: rule.id });
                        }
                      }}
                    >
                      Delete
                    </ViewOnlyActionButton>
                  </div>
                </div>
              ))}
            </div>
          )}

          {canEdit ? (
            <div className="grid grid-cols-1 gap-3 rounded-md border p-3 md:grid-cols-5">
              <div>
                <Label className="text-xs">Membership type</Label>
                <Select value={draftTypeId} onValueChange={setDraftTypeId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any type</SelectItem>
                    {config.membershipTypes.map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Age tier</Label>
                <Select value={draftTier} onValueChange={setDraftTier}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ANY}>Any age</SelectItem>
                    {config.ageTiers.map((tier) => (
                      <SelectItem key={tier} value={tier}>{formatAgeTierName(tier)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Rule kind</Label>
                <Select value={draftMode} onValueChange={(v) => setDraftMode(v as RuleKind)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MANAGED">Managed (add)</SelectItem>
                    <SelectItem value="ACCEPTED">Accepted (tolerate)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Xero group</Label>
                <Select value={draftGroupId} onValueChange={setDraftGroupId}>
                  <SelectTrigger><SelectValue placeholder="Select group" /></SelectTrigger>
                  <SelectContent>
                    {config.groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end">
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  size="sm"
                  disabled={busy || !draftGroupId}
                  onClick={() =>
                    void run(
                      {
                        action: "create-rule",
                        membershipTypeId: draftTypeId === ANY ? null : draftTypeId,
                        ageTier: draftTier === ANY ? null : (draftTier as AgeTier),
                        mode: draftMode,
                        groupId: draftGroupId,
                        groupName: groupName(draftGroupId),
                      },
                      (json) => {
                        setConfig(json as Config);
                        setDraftGroupId("");
                      },
                    )
                  }
                >
                  Add rule
                </ViewOnlyActionButton>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dry-run &amp; bulk re-sync</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Always preview the diff before re-syncing. The dry-run reads the local cache only and
            never calls Xero.
          </p>
          <div className="flex flex-wrap gap-2">
            <ViewOnlyActionButton
              canEdit={canView}
              readOnlyReason="Your admin role cannot view Xero member grouping."
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run({ action: "dry-run" }, (json) => setSnapshot((json as { snapshot: Snapshot }).snapshot))
              }
            >
              Run dry-run diff
            </ViewOnlyActionButton>
            <ViewOnlyActionButton
              canEdit={canEdit}
              size="sm"
              disabled={busy || !snapshot || snapshot.mismatchCount === 0}
              title={!snapshot ? "Run the dry-run first." : undefined}
              onClick={() => {
                if (
                  window.confirm(
                    `Re-sync ${snapshot?.mismatchCount ?? 0} member(s) to Xero? You have reviewed the dry-run diff.`,
                  )
                ) {
                  runBulkResync();
                }
              }}
            >
              Run bulk re-sync
            </ViewOnlyActionButton>
            {resyncState?.nextCursorMemberId ? (
              <ViewOnlyActionButton
                canEdit={canEdit}
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => runBulkResync(resyncState.nextCursorMemberId ?? undefined)}
              >
                Resume re-sync
              </ViewOnlyActionButton>
            ) : null}
          </div>
          {resyncState ? (
            <div className="space-y-1">
              <p className="text-sm text-success">{resyncState.status}</p>
              {resyncState.haltedByDailyLimit ? (
                <p className="text-sm text-danger">
                  Halted by the Xero daily API limit — resume tomorrow with the button above.
                </p>
              ) : resyncState.nextCursorMemberId ? (
                <p className="text-sm text-muted-foreground">
                  More members remain — use “Resume re-sync” to continue from where this chunk
                  stopped.
                </p>
              ) : null}
              {resyncState.failures.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs text-danger">
                    {resyncState.failures.length} member(s) failed (details are ledgered in Xero
                    sync operations):
                  </p>
                  {resyncState.failures.slice(0, 20).map((f) => (
                    <p key={f.memberId} className="text-xs text-muted-foreground">
                      {f.memberId}: {f.error}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {snapshot ? (
            <div className="space-y-2">
              {!snapshot.cacheReady ? (
                <p className="text-sm text-muted-foreground">
                  The Xero contact-group cache has not been refreshed — refresh it before relying on
                  this diff.
                </p>
              ) : (
                <>
                  <p className="text-sm">
                    Mode <strong>{snapshot.mode}</strong>: {snapshot.mismatchCount} member(s) would change —
                    {" "}{snapshot.addCount} add(s), {snapshot.removeCount} remove(s) across{" "}
                    {snapshot.membersConsidered} linked member(s). Estimated{" "}
                    <strong>{snapshot.estimatedXeroCalls}</strong> Xero call(s).
                  </p>
                  {snapshot.skippedNoContact.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {snapshot.skippedNoContact.length} member(s) without a Xero contact were skipped.
                    </p>
                  ) : null}
                  {snapshot.informationalCount > 0 ? (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        {snapshot.informationalCount} member(s) match no rule but currently sit in
                        managed group(s) — shown for information only. The bulk re-sync never
                        touches them; remove them in Xero manually if desired.
                      </p>
                      {snapshot.informational.slice(0, 50).map((m) => (
                        <div key={m.memberId} className="rounded border border-dashed p-2 text-xs text-muted-foreground">
                          <span className="font-medium">{m.memberName}</span> ({formatAgeTierName(m.ageTier)}) — in:{" "}
                          {m.unexpectedManagedGroupIds.map(groupName).join(", ")}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {snapshot.mismatches.length > 0 ? (
                    <div className="space-y-1">
                      {snapshot.mismatches.slice(0, 200).map((m) => (
                        <div key={m.memberId} className="rounded border p-2 text-xs">
                          <span className="font-medium">{m.memberName}</span> ({formatAgeTierName(m.ageTier)}) —{" "}
                          add: {m.addGroupId ? (m.managedGroup?.name ?? m.addGroupId) : "nothing"}; remove:{" "}
                          {m.removeGroupIds.length > 0 ? m.removeGroupIds.map(groupName).join(", ") : "nothing"}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-success">No changes — every linked member is correctly grouped.</p>
                  )}
                </>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
