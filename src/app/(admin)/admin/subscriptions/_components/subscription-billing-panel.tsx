"use client";

import type { FamilyBillingMode } from "@prisma/client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, MailWarning, ReceiptText, RefreshCw } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useConfirm } from "@/components/confirm-dialog";
import { AdminViewOnlyNotice, ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { formatCents } from "@/lib/utils";
import { todayDateOnlyForTimeZone } from "@/lib/date-only";

type BillingData = {
  preview: {
    seasonYear: number;
    decisionDate: string;
    dueDays: number;
    totalCents: number;
    confirmationToken: string;
    entries: Array<{
      key: string;
      membershipTypeName: string;
      billingBasis: string;
      prorationRule: string;
      chargedAmountCents: number;
      coveredMonths: number;
      xeroAccountCode: string | null;
      xeroItemCode: string | null;
      recipient: { name: string };
      coveredMembers: Array<{ id: string; name: string }>;
    }>;
    exceptions: Array<{ fingerprint: string; message: string }>;
  };
  charges: Array<{
    id: string;
    status: string;
    membershipTypeName: string;
    chargedAmountCents: number;
    recipientName: string;
    xeroInvoiceNumber: string | null;
    lastErrorMessage: string | null;
    coverage: Array<{ memberName: string }>;
  }>;
  exceptions: Array<{ id: string; fingerprint: string; message: string }>;
  settings: { invoiceDueDays: number; familyBillingMode: FamilyBillingMode };
};

export function SubscriptionBillingPanel({ seasonYear }: { seasonYear: number }) {
  const { confirm, confirmDialog } = useConfirm();
  const canEditFinance = useAdminAreaEditAccess("finance");
  const [decisionDate, setDecisionDate] = useState(() => todayDateOnlyForTimeZone());
  const [data, setData] = useState<BillingData | null>(null);
  const [dueDays, setDueDays] = useState("30");
  const [familyBillingMode, setFamilyBillingMode] = useState<FamilyBillingMode>("BILL_FAMILY_VIA_BILLING_MEMBER");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [loadFeedback, setLoadFeedback] = useState<{ kind: "error"; text: string } | null>(null);
  const [mutationFeedback, setMutationFeedback] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const loadGeneration = useRef(0);
  const selectionRef = useRef({ seasonYear, decisionDate });
  const visibleExceptions = data
    ? [...new Map([...data.preview.exceptions, ...data.exceptions].map((item) => [item.fingerprint, item])).values()]
    : [];

  const load = useCallback(async () => {
    const selection = selectionRef.current;
    const generation = ++loadGeneration.current;
    setLoading(true);
    setData(null);
    setLoadFeedback(null);
    try {
      const response = await fetch(`/api/admin/subscription-billing?seasonYear=${selection.seasonYear}&decisionDate=${selection.decisionDate}`);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not load billing preview.");
      if (generation !== loadGeneration.current) return;
      setData(body);
      setDueDays(String(body.settings.invoiceDueDays));
      setFamilyBillingMode(body.settings.familyBillingMode);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setData(null);
      setLoadFeedback({ kind: "error", text: error instanceof Error ? error.message : "Could not load billing preview." });
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, []);

  useLayoutEffect(() => {
    selectionRef.current = { seasonYear, decisionDate };
  }, [decisionDate, seasonYear]);

  useEffect(() => {
    void load();
  }, [load, decisionDate, seasonYear]);

  async function post(body: Record<string, unknown>) {
    setWorking(true);
    setMutationFeedback(null);
    try {
      const response = await fetch("/api/admin/subscription-billing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Billing action failed.");
      setMutationFeedback({ kind: "success", text: result.message || "Billing action completed." });
      await load();
    } catch (error) {
      setData(null);
      setMutationFeedback({ kind: "error", text: error instanceof Error ? error.message : "Billing action failed." });
    } finally {
      setWorking(false);
    }
  }

  async function confirmBatch() {
    if (!data || data.preview.seasonYear !== seasonYear || data.preview.decisionDate !== decisionDate) return;
    const accepted = await confirm({
      title: `Create ${data.preview.entries.length} annual membership charge${data.preview.entries.length === 1 ? "" : "s"}?`,
      description: `${formatCents(data.preview.totalCents)} will be snapshotted. This creates durable Xero invoice work and cannot be undone by later fee or family changes. ${data.preview.exceptions.length} exception${data.preview.exceptions.length === 1 ? "" : "s"} will be recorded without invoicing.`,
      confirmLabel: "Confirm annual batch",
    });
    if (!accepted) return;
    await post({
      action: "CONFIRM_ANNUAL_BATCH",
      seasonYear,
      decisionDate,
      confirmationToken: data.preview.confirmationToken,
      confirmed: true,
    });
  }

  return (
    <Card>
      {confirmDialog}
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><ReceiptText className="h-5 w-5" /> Annual Membership Fee billing</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Preview first, then explicitly confirm. Confirmation freezes fee, proration, recipient, family coverage, due days, and amount before Xero work is queued.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label htmlFor="subscription-decision-date">Decision date</Label><Input id="subscription-decision-date" type="date" value={decisionDate} onChange={(event) => { setData(null); setDecisionDate(event.target.value); }} /></div>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading || working}><RefreshCw className="mr-1 h-4 w-4" /> Refresh preview</Button>
          <div className="space-y-1"><Label htmlFor="subscription-due-days">Invoice due days</Label><Input id="subscription-due-days" className="w-28" type="number" min={1} max={365} value={dueDays} disabled={!canEditFinance} onChange={(event) => setDueDays(event.target.value)} /></div>
          <ViewOnlyActionButton canEdit={canEditFinance} type="button" variant="outline" disabled={working || Number(dueDays) < 1 || Number(dueDays) > 365} onClick={() => void post({ action: "UPDATE_SETTINGS", invoiceDueDays: Number(dueDays) })}>Save due days</ViewOnlyActionButton>
        </div>
        <div className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="family-billing-mode">Family billing mode</Label>
              <Select value={familyBillingMode} onValueChange={(value) => setFamilyBillingMode(value as FamilyBillingMode)} disabled={!canEditFinance || working}>
                <SelectTrigger id="family-billing-mode" className="w-80"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="BILL_FAMILY_VIA_BILLING_MEMBER">Bill families via a billing member</SelectItem>
                  <SelectItem value="BILL_MEMBERS_INDIVIDUALLY">Bill members individually</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* Save the mode with the last-SAVED due days (data.settings), not the
                possibly-dirty input, so switching the mode never silently
                persists an unsaved due-days edit. Due days are changed only via
                the separate "Save due days" button above. */}
            <ViewOnlyActionButton canEdit={canEditFinance} type="button" variant="outline" disabled={working || !data} onClick={() => { if (!data) return; void post({ action: "UPDATE_SETTINGS", invoiceDueDays: data.settings.invoiceDueDays, familyBillingMode }); }}>Save billing mode</ViewOnlyActionButton>
          </div>
          <p className="text-sm text-muted-foreground">
            {familyBillingMode === "BILL_FAMILY_VIA_BILLING_MEMBER"
              ? "Each family is invoiced once, to the billing member nominated on Membership & Joining Fees. Per-family fee schedules are allowed and families without an active billing member are flagged as exceptions."
              : "Every member is invoiced directly. The family billing members card is hidden, no billing-member exceptions are raised, and per-family fee schedules are disabled."}
          </p>
        </div>
        {!canEditFinance ? <AdminViewOnlyNotice>Finance view access can inspect previews and charge history. Finance edit access is required to change settings, confirm billing, or retry Xero delivery.</AdminViewOnlyNotice> : null}
        {mutationFeedback ? <Alert variant={mutationFeedback.kind === "success" ? "success" : "error"}>{mutationFeedback.text}</Alert> : null}
        {loadFeedback ? <Alert variant="error">{loadFeedback.text}</Alert> : null}
        {loading ? <Spinner label="Building subscription billing preview…" /> : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Charges</p><p className="text-xl font-semibold tabular-nums">{data.preview.entries.length}</p></div>
              <div><p className="text-xs text-muted-foreground">Preview total</p><p className="text-xl font-semibold tabular-nums">{formatCents(data.preview.totalCents)}</p></div>
              <div><p className="text-xs text-muted-foreground">Open exceptions</p><p className="text-xl font-semibold tabular-nums">{visibleExceptions.length}</p></div>
              <div><p className="text-xs text-muted-foreground">Due</p><p className="text-xl font-semibold tabular-nums">{data.preview.dueDays} days</p></div>
            </div>
            {data.preview.entries.length > 0 ? (
              <div className="space-y-2">
                {data.preview.entries.map((entry) => (
                  <div key={entry.key} className="rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{entry.membershipTypeName} · {entry.recipient.name}</span><span className="tabular-nums">{formatCents(entry.chargedAmountCents)}</span></div>
                    <p className="text-muted-foreground">{entry.billingBasis.replaceAll("_", " ")} · {entry.coveredMonths}/12 months · covers {entry.coveredMembers.map((member) => member.name).join(", ")}{entry.xeroAccountCode ? ` · Xero ${entry.xeroAccountCode}${entry.xeroItemCode ? ` / ${entry.xeroItemCode}` : ""}` : ""}</p>
                  </div>
                ))}
                <ViewOnlyActionButton canEdit={canEditFinance} type="button" onClick={() => void confirmBatch()} disabled={working}>Confirm and queue annual batch</ViewOnlyActionButton>
              </div>
            ) : <Alert variant="info">No new charges are available for this preview. Existing immutable coverage is not regenerated.</Alert>}
            {visibleExceptions.length > 0 ? (
              <Alert variant="warning"><div className="space-y-1"><p className="font-medium">Billing exceptions — no invoice created</p>{visibleExceptions.map((item) => <p key={item.fingerprint}>{item.message}</p>)}</div></Alert>
            ) : null}
            {data.charges.length > 0 ? (
              <div className="space-y-2">
                <h3 className="font-medium">Durable charge queue</h3>
                {data.charges.map((charge) => (
                  <div key={charge.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                    <div><p className="font-medium">{charge.membershipTypeName} · {charge.recipientName} · {formatCents(charge.chargedAmountCents)}</p><p className="text-muted-foreground">{charge.coverage.map((row) => row.memberName).join(", ")} · {charge.xeroInvoiceNumber ?? "No Xero number yet"}</p>{charge.lastErrorMessage ? <p className="text-danger">{charge.lastErrorMessage}</p> : null}</div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{charge.status.replaceAll("_", " ")}</Badge>
                      {charge.status === "EMAIL_FAILED" || charge.status === "CONFLICT" || charge.status === "QUEUED" || charge.status === "INVOICE_CREATED" ? <ViewOnlyActionButton canEdit={canEditFinance} size="sm" variant="outline" disabled={working} onClick={() => void post({ action: "RETRY_CHARGE", chargeId: charge.id })}>{charge.status === "EMAIL_FAILED" ? <MailWarning className="mr-1 h-4 w-4" /> : charge.status === "CONFLICT" ? <AlertTriangle className="mr-1 h-4 w-4" /> : <CheckCircle2 className="mr-1 h-4 w-4" />} Retry</ViewOnlyActionButton> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
