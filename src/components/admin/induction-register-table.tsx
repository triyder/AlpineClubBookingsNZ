"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  type InductionKind,
  type InductionStatus,
  formatInductionDate,
  INDUCTION_KIND_LABELS,
  INDUCTION_STATUS_LABELS,
} from "@/lib/induction-display";

interface RegisterRow {
  id: string;
  kind: InductionKind;
  status: InductionStatus;
  requiredSignOffs: number;
  signOffCount: number;
  completedAt: string | null;
  completionSource: string | null;
  createdAt: string;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    ageTier: string;
  };
}

interface MemberResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

const STATUS_VARIANT: Record<
  InductionStatus,
  "default" | "secondary" | "outline" | "destructive"
> = {
  DRAFT: "outline",
  IN_PROGRESS: "secondary",
  COMPLETED: "default",
  VOIDED: "destructive",
};

const KIND_OPTIONS: InductionKind[] = [
  "RE_INDUCTION",
  "YOUTH_TO_FULL",
  "NEW_MEMBER",
];

export function InductionRegisterTable() {
  const [rows, setRows] = useState<RegisterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  // Create-induction state
  const [memberSearch, setMemberSearch] = useState("");
  const [memberResults, setMemberResults] = useState<MemberResult[]>([]);
  const [selectedMember, setSelectedMember] = useState<MemberResult | null>(null);
  const [newKind, setNewKind] = useState<InductionKind>("RE_INDUCTION");
  const [signerSearch, setSignerSearch] = useState("");
  const [signerResults, setSignerResults] = useState<MemberResult[]>([]);
  const [selectedSigners, setSelectedSigners] = useState<MemberResult[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/admin/inductions?${params.toString()}`, {
        credentials: "same-origin",
      });
      const body = await res.json();
      setRows(body.inductions ?? []);
    } catch {
      toast.error("Failed to load register");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  async function searchMembers() {
    if (!memberSearch.trim()) return;
    const res = await fetch(
      `/api/admin/members?search=${encodeURIComponent(memberSearch.trim())}`,
      { credentials: "same-origin" }
    );
    const body = await res.json().catch(() => ({}));
    setMemberResults((body.members ?? []).slice(0, 10));
  }

  async function searchSigners() {
    if (!signerSearch.trim()) return;
    const res = await fetch(
      `/api/admin/members?search=${encodeURIComponent(signerSearch.trim())}`,
      { credentials: "same-origin" }
    );
    const body = await res.json().catch(() => ({}));
    const results: MemberResult[] = (body.members ?? []).slice(0, 10);
    setSignerResults(results.filter((m) => !selectedSigners.some((s) => s.id === m.id)));
  }

  function addSigner(member: MemberResult) {
    setSelectedSigners((prev) =>
      prev.some((s) => s.id === member.id) ? prev : [...prev, member]
    );
    setSignerSearch("");
    setSignerResults([]);
  }

  function removeSigner(id: string) {
    setSelectedSigners((prev) => prev.filter((s) => s.id !== id));
  }

  async function createInduction() {
    if (!selectedMember) return;
    const res = await fetch("/api/admin/inductions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        memberId: selectedMember.id,
        kind: newKind,
        signerMemberIds: selectedSigners.map((s) => s.id),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast.error(body.error ?? "Failed to create induction");
      return;
    }
    toast.success(
      selectedSigners.length > 0
        ? `Induction created — sign-off request emails sent to ${selectedSigners.length} signer${selectedSigners.length === 1 ? "" : "s"}`
        : "Induction created"
    );
    setSelectedMember(null);
    setMemberResults([]);
    setMemberSearch("");
    setSelectedSigners([]);
    setSignerSearch("");
    void load();
  }

  async function overrideComplete(id: string) {
    const res = await fetch(`/api/admin/inductions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "OVERRIDE_COMPLETE" }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Failed to complete induction");
      return;
    }
    toast.success("Induction marked complete");
    void load();
  }

  async function voidInductionRow(id: string) {
    const reason = window.prompt("Reason for voiding this induction?");
    if (!reason) return;
    const res = await fetch(`/api/admin/inductions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "VOID", reason }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body.error ?? "Failed to void induction");
      return;
    }
    toast.success("Induction voided");
    void load();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Start an induction</CardTitle>
          <CardDescription>
            Create an induction for an existing member, a youth becoming a full
            member, or a re-induction.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="text-xs">Find member</label>
              <Input
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void searchMembers();
                }}
                placeholder="Name or email"
                className="w-64"
              />
            </div>
            <Button size="sm" variant="outline" onClick={searchMembers}>
              Search
            </Button>
            <div className="space-y-1">
              <label className="text-xs">Type</label>
              <select
                value={newKind}
                onChange={(e) => setNewKind(e.target.value as InductionKind)}
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                {KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {INDUCTION_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              onClick={createInduction}
              disabled={!selectedMember}
            >
              Create induction
            </Button>
          </div>
          {selectedMember && (
            <p className="text-sm">
              Selected:{" "}
              <strong>
                {selectedMember.firstName} {selectedMember.lastName}
              </strong>{" "}
              ({selectedMember.email})
            </p>
          )}
          {memberResults.length > 0 && (
            <ul className="space-y-1">
              {memberResults.map((member) => (
                <li key={member.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedMember(member)}
                    className="text-sm text-primary hover:underline"
                  >
                    {member.firstName} {member.lastName} — {member.email}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="border-t pt-3 space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              Assign signers (optional) — they will receive a sign-off request email
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <label className="text-xs">Find signer</label>
                <Input
                  value={signerSearch}
                  onChange={(e) => setSignerSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void searchSigners();
                  }}
                  placeholder="Name or email"
                  className="w-64"
                />
              </div>
              <Button size="sm" variant="outline" onClick={searchSigners}>
                Search
              </Button>
            </div>
            {signerResults.length > 0 && (
              <ul className="space-y-1">
                {signerResults.map((member) => (
                  <li key={member.id}>
                    <button
                      type="button"
                      onClick={() => addSigner(member)}
                      className="text-sm text-primary hover:underline"
                    >
                      + {member.firstName} {member.lastName} — {member.email}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {selectedSigners.length > 0 && (
              <ul className="space-y-1">
                {selectedSigners.map((signer) => (
                  <li key={signer.id} className="flex items-center gap-2 text-sm">
                    <span>
                      {signer.firstName} {signer.lastName}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeSigner(signer.id)}
                      className="text-xs text-destructive hover:underline"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Induction register</CardTitle>
          <CardDescription>
            Signed induction records — useful when appointing hut leaders.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search member"
              className="w-56"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All statuses</option>
              <option value="IN_PROGRESS">In progress</option>
              <option value="COMPLETED">Completed</option>
              <option value="DRAFT">Draft</option>
              <option value="VOIDED">Voided</option>
            </select>
          </div>

          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No induction records found.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sign-offs</TableHead>
                  <TableHead>Completed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="font-medium">
                        {row.member.firstName} {row.member.lastName}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {row.member.email}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {INDUCTION_KIND_LABELS[row.kind]}
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status]}>
                        {INDUCTION_STATUS_LABELS[row.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {row.signOffCount}/{row.requiredSignOffs}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatInductionDate(row.completedAt) ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/induction/${row.id}/print`}>
                            View
                          </Link>
                        </Button>
                        {row.status !== "COMPLETED" &&
                          row.status !== "VOIDED" && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => overrideComplete(row.id)}
                            >
                              Complete
                            </Button>
                          )}
                        {row.status !== "VOIDED" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => voidInductionRow(row.id)}
                          >
                            Void
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
