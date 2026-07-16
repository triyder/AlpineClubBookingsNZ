"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const FOLLOW_XERO = "__xero__";
const NONE = "__none__";

function monthName(month: number | null): string {
  if (month == null || month < 1 || month > 12) return "Unknown";
  return MONTH_NAMES[month - 1];
}

interface LockoutSettings {
  enabled: boolean;
  financialYearEndMonthOverride: number | null;
  textFallbackEnabled: boolean;
}

interface XeroCode {
  code: string;
  name: string;
}

interface AgeTierRow {
  tier: string;
  label: string;
  subscriptionRequiredForBooking?: boolean;
}

export function SubscriptionLockoutSettingsPanel({
  permissionMatrix,
}: {
  permissionMatrix: AdminPermissionMatrix;
}) {
  // This support-area panel fans out to three other areas. Each backing area is
  // gated at `view` so a narrow custom role never fetches into a 403 (seeded
  // roles that reach this page hold all three, so they are unaffected).
  const canMembership = permissionMatrix.membership !== "none";
  const canFinance = permissionMatrix.finance !== "none";
  const canBookings = permissionMatrix.bookings !== "none";

  const [settings, setSettings] = useState<LockoutSettings | null>(null);
  const [subscriptionCode, setSubscriptionCode] = useState<string | null>(null);
  const [subscriptionItemCode, setSubscriptionItemCode] = useState<
    string | null
  >(null);
  const [accounts, setAccounts] = useState<XeroCode[] | null>(null);
  const [items, setItems] = useState<XeroCode[] | null>(null);
  const [xeroYearEndMonth, setXeroYearEndMonth] = useState<number | null>(null);
  const [ageTiers, setAgeTiers] = useState<AgeTierRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        // Only fetch an area's endpoints when the viewer holds it, so a narrow
        // custom role never fires a request that would 403. A skipped fetch
        // resolves to null and leaves its state at the default (same as today's
        // non-ok handling), and the matrix hides the matching section below.
        const [lockoutRes, mappingsRes, accountsRes, itemsRes, orgRes, tiersRes] =
          await Promise.all([
            canMembership
              ? fetch("/api/admin/membership-lockout-settings", {
                  credentials: "same-origin",
                })
              : null,
            canFinance
              ? fetch("/api/admin/xero/account-mappings", {
                  credentials: "same-origin",
                })
              : null,
            canFinance
              ? fetch("/api/admin/xero/chart-of-accounts", {
                  credentials: "same-origin",
                })
              : null,
            canFinance
              ? fetch("/api/admin/xero/items", { credentials: "same-origin" })
              : null,
            canFinance
              ? fetch("/api/admin/xero/organisation", {
                  credentials: "same-origin",
                })
              : null,
            canBookings
              ? fetch("/api/admin/age-tier-settings", {
                  credentials: "same-origin",
                })
              : null,
          ]);

        // In-panel backstop: the settings are the membership-area backbone, so a
        // denial here (matrix↔enforcement drift or a mid-session revocation)
        // hides the whole panel quietly rather than stalling on "Loading…".
        if (
          lockoutRes &&
          (lockoutRes.status === 401 || lockoutRes.status === 403)
        ) {
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              "SubscriptionLockoutSettingsPanel: lockout-settings fetch denied; hiding panel (matrix/enforcement drift or revoked session?)",
            );
          }
          setForbidden(true);
          return;
        }

        const lockoutBody = lockoutRes?.ok ? await lockoutRes.json() : null;
        if (lockoutBody?.settings) {
          setSettings(lockoutBody.settings as LockoutSettings);
        }

        const mappingsBody = mappingsRes?.ok ? await mappingsRes.json() : null;
        if (mappingsBody?.subscriptionIncome) {
          setSubscriptionCode(mappingsBody.subscriptionIncome.code ?? null);
          setSubscriptionItemCode(
            mappingsBody.subscriptionIncome.itemCode ?? null,
          );
        }

        // Xero reference data is only available when Xero is connected.
        if (accountsRes?.ok) {
          const body = await accountsRes.json();
          setAccounts((body.accounts as XeroCode[]) ?? []);
        }
        if (itemsRes?.ok) {
          const body = await itemsRes.json();
          setItems((body.items as XeroCode[]) ?? []);
        }
        if (orgRes?.ok) {
          const body = await orgRes.json();
          setXeroYearEndMonth(body.financialYearEndMonth ?? null);
        }
        if (tiersRes?.ok) {
          const body = await tiersRes.json();
          setAgeTiers((body.settings as AgeTierRow[]) ?? []);
        }
      } catch {
        toast.error("Failed to load lockout settings");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [canMembership, canFinance, canBookings]);

  function update(patch: Partial<LockoutSettings>) {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const lockoutRes = await fetch("/api/admin/membership-lockout-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          enabled: settings.enabled,
          financialYearEndMonthOverride: settings.financialYearEndMonthOverride,
          textFallbackEnabled: settings.textFallbackEnabled,
        }),
      });
      const lockoutBody = await lockoutRes.json().catch(() => ({}));
      if (!lockoutRes.ok) {
        toast.error(lockoutBody.error ?? "Failed to save settings");
        return;
      }
      if (lockoutBody.settings) {
        setSettings(lockoutBody.settings as LockoutSettings);
      }

      // Persist the detection codes via the shared Xero account-mappings row so
      // there is a single source of truth with the Xero mappings panel. Send
      // only the subscriptionIncome key so other mappings are untouched. Skipped
      // for a viewer without finance access, whose detection card is hidden and
      // whose codes were never loaded (writing them would 403 and — worse —
      // attempt to null out a mapping they cannot see).
      if (canFinance) {
        const mappingsRes = await fetch("/api/admin/xero/account-mappings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            subscriptionIncome: {
              code: subscriptionCode,
              itemCode: subscriptionItemCode,
            },
          }),
        });
        if (!mappingsRes.ok) {
          const body = await mappingsRes.json().catch(() => ({}));
          toast.error(body.error ?? "Failed to save detection codes");
          return;
        }
      }

      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  // The panel is membership-backed: without `settings` nothing can render, so a
  // viewer lacking membership (or a drift denial) gets a quiet render-nothing
  // rather than a stuck "Loading settings…". The page keeps its own heading.
  if (forbidden || !canMembership) {
    return null;
  }

  if (loading || !settings) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  const xeroConnected = accounts !== null;
  const overrideValue =
    settings.financialYearEndMonthOverride == null
      ? FOLLOW_XERO
      : String(settings.financialYearEndMonthOverride);
  const effectiveMonth =
    settings.financialYearEndMonthOverride ?? xeroYearEndMonth ?? 3;
  const requiredTiers = ageTiers.filter(
    (t) => t.subscriptionRequiredForBooking,
  );
  const exemptTiers = ageTiers.filter(
    (t) => !t.subscriptionRequiredForBooking,
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Booking lockout</CardTitle>
          <CardDescription>
            Block members with an unpaid Annual Membership Fee from booking.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <label className="flex items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={settings.enabled}
              onCheckedChange={(checked) =>
                update({ enabled: checked === true })
              }
            />
            <span className="text-sm">
              <span className="font-medium">Enforce the booking lockout</span>
              <span className="block text-muted-foreground">
                When on, members whose subscription is not paid for the current
                season cannot book, and they see an unpaid-subscription banner.
                When off, all members can book regardless of subscription, and
                the banner is hidden.
              </span>
            </span>
          </label>

          {/* Xero connection status is finance-area; only shown to a finance
              viewer so we never assert "not connected" to someone who simply
              cannot see finance (the Xero fetches were skipped for them). */}
          {canFinance ? (
            settings.enabled && !xeroConnected ? (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
                <span className="font-medium">Heads up:</span> the lockout is on,
                but Xero is not connected, so the system cannot read anyone&rsquo;s
                paid status. While Xero is disconnected the lockout has no effect
                and all members can book.{" "}
                <Link href="/admin/xero/setup" className="font-medium underline">
                  Connect Xero
                </Link>{" "}
                to enforce it.
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                The lockout has no effect while Xero is disconnected, since a paid
                status can only come from Xero. It also respects the per-age-tier
                rule below.
              </p>
            )
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Financial year</CardTitle>
          <CardDescription>
            Sets the subscription season window (when an annual invoice is raised
            and the period it covers).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Reads the Xero organisation's year-end (finance area); hidden from a
              non-finance viewer so we do not assert a Xero connection state they
              cannot verify. The override control below is a membership setting. */}
          {canFinance ? (
            <p className="text-sm">
              {xeroYearEndMonth
                ? `Your Xero organisation's financial year ends in ${monthName(
                    xeroYearEndMonth,
                  )}.`
                : "Could not read the financial year from Xero (not connected, or unavailable). The March default applies unless you set an override."}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="fy-override">Financial year-end month</Label>
            <Select
              value={overrideValue}
              onValueChange={(value) =>
                update({
                  financialYearEndMonthOverride:
                    value === FOLLOW_XERO ? null : Number(value),
                })
              }
            >
              <SelectTrigger id="fy-override" className="w-full sm:w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_XERO}>
                  Follow Xero{xeroYearEndMonth ? ` (${monthName(xeroYearEndMonth)})` : ""}
                </SelectItem>
                {MONTH_NAMES.map((name, index) => (
                  <SelectItem key={name} value={String(index + 1)}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Leave on &quot;Follow Xero&quot; unless your membership subscription
              year differs from your accounting year. The season currently runs
              from {monthName((effectiveMonth % 12) + 1)} to{" "}
              {monthName(effectiveMonth)}.
            </p>
          </div>

          {settings.financialYearEndMonthOverride != null && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              Changing the financial year-end month changes how every existing
              and future subscription season is calculated. Only set an override
              if your membership year genuinely differs from your Xero accounting
              year. Existing subscription records are not migrated.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Paid-subscription detection reads and writes Xero account/item codes —
          finance area. Hidden from a viewer without finance access. */}
      {canFinance ? (
      <Card>
        <CardHeader>
          <CardTitle>Paid-subscription detection</CardTitle>
          <CardDescription>
            How a Xero invoice is recognised as a paid membership subscription.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!xeroConnected && (
            <p className="text-sm text-muted-foreground">
              <Link href="/admin/xero/setup" className="font-medium underline">
                Connect Xero
              </Link>{" "}
              to choose account and item codes from your chart of accounts.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="sub-account">Subscription account code</Label>
            <Select
              value={subscriptionCode ?? NONE}
              onValueChange={(value) =>
                setSubscriptionCode(value === NONE ? null : value)
              }
              disabled={!xeroConnected}
            >
              <SelectTrigger id="sub-account" className="w-full sm:w-[360px]">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  <span className="text-muted-foreground">Not set</span>
                </SelectItem>
                {(accounts ?? []).map((a) => (
                  <SelectItem key={a.code} value={a.code}>
                    {a.code} - {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              An invoice line posted to this chart-of-account code counts as a
              subscription. Defaults to 203 (Annual Subs) when unset.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sub-item">Subscription item code (optional)</Label>
            <Select
              value={subscriptionItemCode ?? NONE}
              onValueChange={(value) =>
                setSubscriptionItemCode(value === NONE ? null : value)
              }
              disabled={!xeroConnected}
            >
              <SelectTrigger id="sub-item" className="w-full sm:w-[360px]">
                <SelectValue placeholder="Not set" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  <span className="text-muted-foreground">Not set</span>
                </SelectItem>
                {(items ?? []).map((i) => (
                  <SelectItem key={i.code} value={i.code}>
                    {i.code} - {i.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              An invoice line using this Xero item also counts, even if its
              account code differs.
            </p>
          </div>

          <label className="flex items-start gap-3">
            <Checkbox
              className="mt-0.5"
              checked={settings.textFallbackEnabled}
              onCheckedChange={(checked) =>
                update({ textFallbackEnabled: checked === true })
              }
            />
            <span className="text-sm">
              <span className="font-medium">Match on invoice text as well</span>
              <span className="block text-muted-foreground">
                Also count an invoice whose reference or a line description reads
                like a membership subscription. Useful as a safety net, but can
                cause false matches; turn off for strict code-only matching.
              </span>
            </span>
          </label>
        </CardContent>
      </Card>
      ) : null}

      {/* Age tiers are a bookings-area setting. Hidden from a viewer without
          bookings access. */}
      {canBookings ? (
      <Card>
        <CardHeader>
          <CardTitle>Age tiers</CardTitle>
          <CardDescription>
            Which age tiers must have a paid subscription to book. Edit these on
            the age tier settings page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ageTiers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Age tier settings unavailable.
            </p>
          ) : (
            <div className="text-sm">
              <p>
                <span className="font-medium">Subscription required:</span>{" "}
                {requiredTiers.length > 0
                  ? requiredTiers.map((t) => t.label).join(", ")
                  : "None"}
              </p>
              <p className="mt-1">
                <span className="font-medium">Exempt:</span>{" "}
                {exemptTiers.length > 0
                  ? exemptTiers.map((t) => t.label).join(", ")
                  : "None"}
              </p>
            </div>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href="/admin/age-tier-settings">Edit age tier settings</Link>
          </Button>
        </CardContent>
      </Card>
      ) : null}

      <Button onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save settings"}
      </Button>
    </div>
  );
}
