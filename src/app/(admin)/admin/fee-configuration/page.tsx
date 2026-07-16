"use client";

import type { FamilyBillingMode } from "@prisma/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DollarSign, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseDecimalDollarsToCents } from "@/lib/money-input";
import { formatDateOnly, getTodayDateOnly } from "@/lib/date-only";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";

type Fee = { id: string; amountCents: number; effectiveFrom: string; effectiveTo: string | null; billingBasis?: string; prorationRule?: string };
type Data = {
  canEdit: boolean;
  familyBillingMode: FamilyBillingMode;
  membershipTypes: Array<{ id: string; name: string; isActive: boolean; annualFees: Fee[] }>;
  entranceFees: Array<Fee & { category: string }>;
  currentEntranceFees: Array<{ category: string; amountCents: number | null; source: string }>;
  familyGroups: Array<{
    id: string; name: string | null; billingMemberId: string | null; billingException: boolean;
    members: Array<{ id: string; firstName: string; lastName: string; email: string; active: boolean }>;
  }>;
};

const categories = ["ADULT", "YOUTH", "CHILD", "FAMILY"] as const;
const today = formatDateOnly(getTodayDateOnly());
const dollars = (cents: number | null) => cents == null ? "Not configured" : new Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" }).format(cents / 100);
const memberName = (member: { firstName: string; lastName: string }) => `${member.firstName} ${member.lastName}`.trim();

export default function FeeConfigurationPage() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [membershipTypeId, setMembershipTypeId] = useState("");
  const [membershipAmount, setMembershipAmount] = useState("");
  const [billingBasis, setBillingBasis] = useState("PER_MEMBER");
  const [prorationRule, setProrationRule] = useState("NONE");
  const [membershipFrom, setMembershipFrom] = useState(today);
  const [membershipTo, setMembershipTo] = useState("");
  const [entranceCategory, setEntranceCategory] = useState<string>("ADULT");
  const [entranceAmount, setEntranceAmount] = useState("");
  const [entranceFrom, setEntranceFrom] = useState(today);
  const [entranceTo, setEntranceTo] = useState("");
  const [editingMembershipFeeId, setEditingMembershipFeeId] = useState<string | null>(null);
  const [editingEntranceFeeId, setEditingEntranceFeeId] = useState<string | null>(null);
  // Per-section edit-mode toggles: each section loads read-only and only exposes
  // its controls once the operator clicks Edit (repo-standard local-boolean +
  // state-mirror pattern; see admin/lodge AccountCard). No API call fires until
  // that section's own Save/commit button.
  const [membershipEditing, setMembershipEditing] = useState(false);
  const [entranceEditing, setEntranceEditing] = useState(false);
  const [familyEditing, setFamilyEditing] = useState(false);
  // Staged family billing selections. Mirrors the saved billing member per group
  // while editing so the Select no longer writes on change; committed on Save,
  // discarded on Cancel.
  const [stagedBilling, setStagedBilling] = useState<Record<string, string | null>>({});
  const [deleteTarget, setDeleteTarget] = useState<{ action: "DELETE_MEMBERSHIP_FEE" | "DELETE_ENTRANCE_FEE"; id: string; label: string } | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const { scrollToError } = useScrollToFeedback();

  const load = useCallback(async () => {
    const response = await fetch("/api/admin/fee-configuration");
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Failed to load fee configuration");
    setData(body);
  }, []);
  useEffect(() => { load().catch((cause) => setError(cause instanceof Error ? cause.message : "Failed to load")); }, [load]);
  useEffect(() => {
    if (!membershipTypeId && data?.membershipTypes[0]) setMembershipTypeId(data.membershipTypes[0].id);
  }, [data, membershipTypeId]);
  useEffect(() => { if (error) scrollToError(errorRef); }, [error, scrollToError]);

  const exceptions = useMemo(() => data?.familyGroups.filter((group) => group.billingException) ?? [], [data]);
  // When the club bills members individually there is no family-billing surface:
  // the card is hidden and per-family fee schedules are disallowed. The server
  // enforces both; these flags only drive what the operator sees.
  const familyBillingActive = data?.familyBillingMode === "BILL_FAMILY_VIA_BILLING_MEMBER";
  const hasPerFamilySchedule = useMemo(
    () => data?.membershipTypes.some((type) => type.annualFees.some((fee) => fee.billingBasis === "PER_FAMILY")) ?? false,
    [data],
  );
  async function mutate(payload: Record<string, unknown>, options?: { silent?: boolean }) {
    setSaving(true); setError(null);
    try {
      const response = await fetch("/api/admin/fee-configuration", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Failed to save fee configuration");
      setData(body);
      // The family-billing loop suppresses per-call success toasts and fires one
      // summary instead; errors still toast so a mid-loop failure is visible.
      const action = String(payload.action);
      if (!options?.silent) toast.success(action.startsWith("DELETE_") ? "Fee schedule deleted" : action === "SET_FAMILY_BILLING_MEMBER" ? "Billing member updated" : "Fee schedule saved");
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Failed to save";
      setError(message);
      toast.error(message);
      return false;
    }
    finally { setSaving(false); }
  }
  function resetMembershipForm() {
    setEditingMembershipFeeId(null); setMembershipAmount(""); setBillingBasis("PER_MEMBER");
    setProrationRule("NONE"); setMembershipFrom(today); setMembershipTo("");
  }
  function resetEntranceForm() {
    setEditingEntranceFeeId(null); setEntranceAmount(""); setEntranceFrom(today); setEntranceTo("");
  }
  function cancelMembershipEditing() { resetMembershipForm(); setMembershipEditing(false); }
  function cancelEntranceEditing() { resetEntranceForm(); setEntranceEditing(false); }
  function startFamilyEditing() {
    setStagedBilling(Object.fromEntries((data?.familyGroups ?? []).map((group) => [group.id, group.billingMemberId])));
    setFamilyEditing(true);
  }
  function cancelFamilyEditing() { setStagedBilling({}); setFamilyEditing(false); }
  async function saveFamilyBilling() {
    const changed = (data?.familyGroups ?? []).filter((group) => (stagedBilling[group.id] ?? null) !== (group.billingMemberId ?? null));
    for (const group of changed) {
      // Same SET_FAMILY_BILLING_MEMBER payload as before; only the timing moved
      // from onValueChange to this Save. One call per changed family (unchanged
      // API contract). Stop on the first failure so staged edits are preserved.
      // Suppress the per-call toast; a single summary fires once the loop clears.
      const saved = await mutate({ action: "SET_FAMILY_BILLING_MEMBER", familyGroupId: group.id, billingMemberId: stagedBilling[group.id] ?? null }, { silent: true });
      if (!saved) return;
    }
    setStagedBilling({}); setFamilyEditing(false);
    if (changed.length > 0) toast.success("Billing members updated");
  }
  const billingMemberLabel = (group: Data["familyGroups"][number]) => {
    if (!group.billingMemberId) return "No billing member";
    const member = group.members.find((candidate) => candidate.id === group.billingMemberId);
    return member ? `${memberName(member)} · ${member.email}${member.active ? "" : " (inactive)"}` : "No billing member";
  };
  function saveMembershipFee() {
    const amountCents = parseDecimalDollarsToCents(membershipAmount);
    if (amountCents == null) { setError("Enter an NZD amount with no more than two decimal places."); return; }
    void mutate({
      action: editingMembershipFeeId ? "UPDATE_MEMBERSHIP_FEE" : "CREATE_MEMBERSHIP_FEE",
      ...(editingMembershipFeeId ? { id: editingMembershipFeeId } : { membershipTypeId }),
      amountCents, billingBasis, prorationRule, effectiveFrom: membershipFrom, effectiveTo: membershipTo || null,
    }).then((saved) => { if (saved) resetMembershipForm(); });
  }
  function saveEntranceFee() {
    const amountCents = parseDecimalDollarsToCents(entranceAmount);
    if (amountCents == null) { setError("Enter an NZD amount with no more than two decimal places."); return; }
    void mutate({
      action: editingEntranceFeeId ? "UPDATE_ENTRANCE_FEE" : "CREATE_ENTRANCE_FEE",
      ...(editingEntranceFeeId ? { id: editingEntranceFeeId } : { category: entranceCategory }),
      amountCents, effectiveFrom: entranceFrom, effectiveTo: entranceTo || null,
    }).then((saved) => { if (saved) resetEntranceForm(); });
  }

  return <div className="space-y-6">
    <AdminPageHeader title="Membership & Joining Fees" description="Manage the authoritative, effective-dated fee schedules and family invoice recipients." />
    {error && <div ref={errorRef}><Alert variant="error">{error}</Alert></div>}
    {data && !data.canEdit && <Alert>Finance view access is read-only. Ask a finance editor to change fee schedules or family billing members.</Alert>}
    {exceptions.length > 0 && <Alert variant="warning">
      <span>{exceptions.length} membered {exceptions.length === 1 ? "family has" : "families have"} no billing member. They will be omitted from family invoice generation.</span>
    </Alert>}

    <Card><CardHeader className="flex flex-row items-center justify-between"><div className="space-y-1"><CardTitle>Annual membership fees</CardTitle><CardDescription>the fee to be a paid-up member of the club</CardDescription></div>{data?.canEdit && !membershipEditing && <Button variant="outline" size="sm" aria-label="Edit membership fees" onClick={() => setMembershipEditing(true)}>Edit</Button>}</CardHeader><CardContent className="space-y-5">
      <p className="text-sm text-muted-foreground">Amounts are GST-inclusive integer cents after saving. Effective ranges are inclusive and may not overlap for one membership type.</p>
      {!familyBillingActive && hasPerFamilySchedule && <Alert variant="warning">
        <span>This club bills members individually, but one or more schedules still use the per-family basis. Those schedules cannot be invoiced and are not reinterpreted; edit each one to a per-member or no-invoice basis. Per-family can only be chosen after switching the family billing mode on the subscription billing settings.</span>
      </Alert>}
      {membershipEditing && <>
        <div className="grid gap-3 md:grid-cols-3">
          <div><Label htmlFor="membership-type">Membership type</Label><Select value={membershipTypeId} onValueChange={setMembershipTypeId} disabled={!!editingMembershipFeeId}><SelectTrigger id="membership-type"><SelectValue /></SelectTrigger><SelectContent>{data?.membershipTypes.map((type) => <SelectItem key={type.id} value={type.id}>{type.name}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="membership-amount">Annual amount (NZD)</Label><Input id="membership-amount" inputMode="decimal" value={membershipAmount} onChange={(event) => setMembershipAmount(event.target.value)} placeholder="150.00" disabled={billingBasis === "NO_INVOICE"} /></div>
          <div><Label htmlFor="billing-basis">Billing basis</Label><Select value={billingBasis} onValueChange={(value) => { setBillingBasis(value); if (value === "NO_INVOICE") setMembershipAmount("0"); }}><SelectTrigger id="billing-basis"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="PER_MEMBER">Per member</SelectItem>{familyBillingActive && <SelectItem value="PER_FAMILY">Per family</SelectItem>}<SelectItem value="NO_INVOICE">No invoice</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="proration-rule">Proration</Label><Select value={prorationRule} onValueChange={setProrationRule}><SelectTrigger id="proration-rule"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="NONE">Full annual fee</SelectItem><SelectItem value="REMAINING_MONTHS_INCLUSIVE">Remaining months, including decision month</SelectItem></SelectContent></Select></div>
          <div><Label htmlFor="membership-from">Effective from</Label><Input id="membership-from" type="date" value={membershipFrom} onChange={(event) => setMembershipFrom(event.target.value)} /></div>
          <div><Label htmlFor="membership-to">Effective to (optional)</Label><Input id="membership-to" type="date" value={membershipTo} onChange={(event) => setMembershipTo(event.target.value)} /></div>
        </div>
        <div className="flex gap-2"><Button disabled={saving || !membershipTypeId} onClick={saveMembershipFee}><DollarSign className="mr-1 h-4 w-4" />{editingMembershipFeeId ? "Update annual fee" : "Add annual fee"}</Button>{editingMembershipFeeId && <Button variant="outline" onClick={resetMembershipForm}>Cancel edit</Button>}<Button variant="ghost" disabled={saving} onClick={cancelMembershipEditing}>Close section</Button></div>
      </>}
      <div className="space-y-3">{data?.membershipTypes.map((type) => <div key={type.id} className="rounded-md border p-3"><div className="font-medium">{type.name}</div>{type.annualFees.length === 0 ? <p className="text-sm text-muted-foreground">Not configured</p> : type.annualFees.map((fee) => <div key={fee.id} className="mt-2 flex flex-wrap items-center gap-2 text-sm"><Badge variant="outline">{dollars(fee.amountCents)}</Badge><span>{fee.billingBasis?.replaceAll("_", " ")}</span><span>{fee.effectiveFrom} – {fee.effectiveTo ?? "ongoing"}</span>{membershipEditing && <><Button size="icon" variant="ghost" aria-label={`Edit ${type.name} fee`} disabled={saving} onClick={() => { setEditingMembershipFeeId(fee.id); setMembershipTypeId(type.id); setMembershipAmount((fee.amountCents / 100).toFixed(2)); setBillingBasis(fee.billingBasis ?? "PER_MEMBER"); setProrationRule(fee.prorationRule ?? "NONE"); setMembershipFrom(fee.effectiveFrom); setMembershipTo(fee.effectiveTo ?? ""); }}><Pencil className="h-4 w-4" /></Button><Button size="icon" variant="ghost" aria-label={`Delete ${type.name} fee`} disabled={saving} onClick={() => setDeleteTarget({ action: "DELETE_MEMBERSHIP_FEE", id: fee.id, label: `${type.name} annual fee from ${fee.effectiveFrom}` })}><Trash2 className="h-4 w-4" /></Button></>}</div>)}</div>)}</div>
    </CardContent></Card>

    <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>Joining fees</CardTitle>{data?.canEdit && !entranceEditing && <Button variant="outline" size="sm" aria-label="Edit joining fees" onClick={() => setEntranceEditing(true)}>Edit</Button>}</CardHeader><CardContent className="space-y-5">
      {entranceEditing && <>
        <div className="grid gap-3 md:grid-cols-4">
          <div><Label htmlFor="entrance-category">Category</Label><Select value={entranceCategory} onValueChange={setEntranceCategory} disabled={!!editingEntranceFeeId}><SelectTrigger id="entrance-category"><SelectValue /></SelectTrigger><SelectContent>{categories.map((category) => <SelectItem key={category} value={category}>{category}</SelectItem>)}</SelectContent></Select></div>
          <div><Label htmlFor="entrance-amount">Amount (NZD)</Label><Input id="entrance-amount" inputMode="decimal" value={entranceAmount} onChange={(event) => setEntranceAmount(event.target.value)} placeholder="75.00" /></div>
          <div><Label htmlFor="entrance-from">Effective from</Label><Input id="entrance-from" type="date" value={entranceFrom} onChange={(event) => setEntranceFrom(event.target.value)} /></div>
          <div><Label htmlFor="entrance-to">Effective to (optional)</Label><Input id="entrance-to" type="date" value={entranceTo} onChange={(event) => setEntranceTo(event.target.value)} /></div>
        </div>
        <div className="flex gap-2"><Button disabled={saving} onClick={saveEntranceFee}>{editingEntranceFeeId ? "Update joining fee" : "Add joining fee"}</Button>{editingEntranceFeeId && <Button variant="outline" onClick={resetEntranceForm}>Cancel edit</Button>}<Button variant="ghost" disabled={saving} onClick={cancelEntranceEditing}>Close section</Button></div>
      </>}
      <div className="grid gap-3 md:grid-cols-2">{categories.map((category) => { const current = data?.currentEntranceFees.find((fee) => fee.category === category); const rows = data?.entranceFees.filter((fee) => fee.category === category) ?? []; return <div key={category} className="rounded-md border p-3"><div className="flex items-center justify-between"><span className="font-medium">{category}</span><Badge variant={current?.source === "SCHEDULE" ? "default" : "outline"}>{current?.source === "LEGACY_MAPPING" ? "Compatibility fallback" : current?.source ?? "None"}</Badge></div><p className="text-sm">Current: {dollars(current?.amountCents ?? null)}</p>{rows.map((fee) => <div key={fee.id} className="mt-2 flex items-center gap-2 text-sm"><span>{dollars(fee.amountCents)} · {fee.effectiveFrom} – {fee.effectiveTo ?? "ongoing"}</span>{entranceEditing && <><Button size="icon" variant="ghost" aria-label={`Edit ${category} fee`} disabled={saving} onClick={() => { setEditingEntranceFeeId(fee.id); setEntranceCategory(category); setEntranceAmount((fee.amountCents / 100).toFixed(2)); setEntranceFrom(fee.effectiveFrom); setEntranceTo(fee.effectiveTo ?? ""); }}><Pencil className="h-4 w-4" /></Button><Button size="icon" variant="ghost" aria-label={`Delete ${category} fee`} disabled={saving} onClick={() => setDeleteTarget({ action: "DELETE_ENTRANCE_FEE", id: fee.id, label: `${category} joining fee from ${fee.effectiveFrom}` })}><Trash2 className="h-4 w-4" /></Button></>}</div>)}</div>; })}</div>
    </CardContent></Card>

    {familyBillingActive && <Card><CardHeader className="flex flex-row items-center justify-between"><CardTitle>Family billing members</CardTitle>{data?.canEdit && !familyEditing && <Button variant="outline" size="sm" aria-label="Edit family billing" onClick={startFamilyEditing}>Edit</Button>}</CardHeader><CardContent className="space-y-3">
      <p className="text-sm text-muted-foreground">Choose the explicit invoice recipient for each membered family. Login holder and family admin are not inferred.</p>
      {data?.familyGroups.length === 0 && <p className="text-sm text-muted-foreground">No membered families.</p>}
      {data?.familyGroups.map((group) => { const selectId = `family-billing-${group.id}`; return <div key={group.id} className="grid items-center gap-2 rounded-md border p-3 md:grid-cols-[1fr_2fr]"><div><div className="font-medium">{group.name || "Unnamed family"}</div>{group.billingException && <span className="text-sm text-amber-700">Billing exception</span>}</div><div>{familyEditing ? <><Label htmlFor={selectId}>Billing member</Label><Select value={stagedBilling[group.id] ?? "none"} onValueChange={(value) => setStagedBilling((prev) => ({ ...prev, [group.id]: value === "none" ? null : value }))} disabled={saving}><SelectTrigger id={selectId}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No billing member</SelectItem>{group.members.map((member) => <SelectItem key={member.id} value={member.id} disabled={!member.active}>{memberName(member)} · {member.email}{member.active ? "" : " (inactive)"}</SelectItem>)}</SelectContent></Select></> : <><div className="text-sm text-muted-foreground">Billing member</div><p className="text-sm">{billingMemberLabel(group)}</p></>}</div></div>; })}
      {familyEditing && <div className="flex gap-2"><Button disabled={saving} onClick={() => void saveFamilyBilling()}>Save billing members</Button><Button variant="ghost" disabled={saving} onClick={cancelFamilyEditing}>Cancel</Button></div>}
    </CardContent></Card>}
    <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open && !saving) setDeleteTarget(null); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader><DialogTitle>Delete fee schedule?</DialogTitle><DialogDescription>Delete {deleteTarget?.label}? This removes configuration, not historical invoices. A deprecated entrance mapping may become the active compatibility fallback.</DialogDescription></DialogHeader>
        <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={saving || !deleteTarget} onClick={async () => { if (!deleteTarget) return; if (await mutate({ action: deleteTarget.action, id: deleteTarget.id })) setDeleteTarget(null); }}>Delete fee</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
