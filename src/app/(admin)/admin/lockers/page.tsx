"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/confirm-dialog";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select";

type MemberSummary = {
  id: string;
  firstName: string;
  lastName: string;
};

type LockerRecord = {
  id: string;
  name: string;
  allocatedToMemberId: string | null;
  allocatedTo: MemberSummary | null;
};

type SortField = "name" | "allocatedTo";

function memberDisplayName(member: MemberSummary | null): string {
  if (!member) {
    return "Unallocated";
  }
  return `${member.firstName} ${member.lastName}`.trim();
}

function handleAllocatedToSearchKeyDown(
  event: React.KeyboardEvent<HTMLInputElement>,
) {
  // Prevent Select typeahead from hijacking focus as users type in search.
  event.stopPropagation();
}

export default function LockersPage() {
  const { confirm, confirmDialog } = useConfirm();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [allocatedToMemberId, setAllocatedToMemberId] =
    useState<string>("UNALLOCATED");
  const [allocatedToSearch, setAllocatedToSearch] = useState("");
  const [editingLockerId, setEditingLockerId] = useState<string | null>(null);
  const [deletingLockerId, setDeletingLockerId] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberSummary[]>([]);
  const [lockers, setLockers] = useState<LockerRecord[]>([]);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  // Lodge context for the page; LodgeSelect renders nothing (and reports the
  // sole lodge) while fewer than two lodges exist (ADR-002).
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  // Hub links (ADR-003) land pre-filtered; read synchronously so the first
  // fetch is already lodge-filtered.
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation);
  const [bulkCount, setBulkCount] = useState("");
  const [bulkNamePrefix, setBulkNamePrefix] = useState("Locker");
  const [bulkSaving, setBulkSaving] = useState(false);

  const loadData = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        lodgeId
          ? `/api/admin/lockers?lodgeId=${encodeURIComponent(lodgeId)}`
          : "/api/admin/lockers",
        { signal },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Failed to load lockers");
      }

      setMembers(body.members ?? []);
      setLockers(body.lockers ?? []);
    } catch (loadError) {
      // An aborted request means the lodge changed (or the page unmounted);
      // a newer request owns the list now.
      if (loadError instanceof DOMException && loadError.name === "AbortError") {
        return;
      }
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load lockers",
      );
    } finally {
      setLoading(false);
    }
  }, [lodgeId]);

  useEffect(() => {
    const controller = new AbortController();
    loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  async function handleFormSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const payload = {
        name,
        allocatedToMemberId:
          allocatedToMemberId === "UNALLOCATED" ? null : allocatedToMemberId,
        // Lodge is set at creation from the page's lodge context and cannot
        // be changed by an update.
        ...(editingLockerId ? {} : { lodgeId: lodgeId ?? undefined }),
      };
      const response = editingLockerId
        ? await fetch(`/api/admin/lockers/${editingLockerId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/admin/lockers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.error ||
            (editingLockerId
              ? "Failed to update locker"
              : "Failed to create locker"),
        );
      }

      if (editingLockerId) {
        setLockers((previous) =>
          previous.map((locker) =>
            locker.id === editingLockerId ? body.locker : locker,
          ),
        );
      } else {
        setLockers((previous) => [...previous, body.locker]);
      }

      setEditingLockerId(null);
      setName("");
      setAllocatedToMemberId("UNALLOCATED");
      setAllocatedToSearch("");
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : editingLockerId
            ? "Failed to update locker"
            : "Failed to create locker",
      );
    } finally {
      setSaving(false);
    }
  }

  function beginEdit(locker: LockerRecord) {
    setEditingLockerId(locker.id);
    setName(locker.name);
    setAllocatedToMemberId(locker.allocatedToMemberId ?? "UNALLOCATED");
    setAllocatedToSearch("");
    setError("");
  }

  function resetForm() {
    setEditingLockerId(null);
    setName("");
    setAllocatedToMemberId("UNALLOCATED");
    setAllocatedToSearch("");
    setError("");
  }

  async function deleteLocker(locker: LockerRecord) {
    if (
      !(await confirm({
        title: `Delete locker ${locker.name}?`,
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }

    setDeletingLockerId(locker.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/lockers/${locker.id}`, {
        method: "DELETE",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error || "Failed to delete locker");
      }

      setLockers((previous) =>
        previous.filter((current) => current.id !== locker.id),
      );
      if (editingLockerId === locker.id) {
        resetForm();
      }
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete locker",
      );
    } finally {
      setDeletingLockerId(null);
    }
  }

  async function bulkCreateLockers() {
    const count = Number(bulkCount);
    setBulkSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/lockers/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          count,
          namePrefix: bulkNamePrefix.trim() || undefined,
          ...(lodgeId ? { lodgeId } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "Failed to create lockers");
      }
      setBulkCount("");
      await loadData();
    } catch (bulkError) {
      setError(
        bulkError instanceof Error
          ? bulkError.message
          : "Failed to create lockers",
      );
    } finally {
      setBulkSaving(false);
    }
  }

  function toggleSort(nextField: SortField) {
    if (sortField === nextField) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }

    setSortField(nextField);
    setSortDirection("asc");
  }

  const sortedLockers = useMemo(() => {
    const clone = [...lockers];
    clone.sort((a, b) => {
      const aValue =
        sortField === "name" ? a.name : memberDisplayName(a.allocatedTo);
      const bValue =
        sortField === "name" ? b.name : memberDisplayName(b.allocatedTo);

      const result = aValue.localeCompare(bValue, "en-NZ", {
        sensitivity: "base",
      });
      return sortDirection === "asc" ? result : -result;
    });

    return clone;
  }, [lockers, sortDirection, sortField]);

  const filteredMembers = useMemo(() => {
    const query = allocatedToSearch.trim().toLocaleLowerCase("en-NZ");
    if (!query) {
      return members;
    }

    return members.filter((member) =>
      memberDisplayName(member).toLocaleLowerCase("en-NZ").includes(query),
    );
  }, [allocatedToSearch, members]);

  const SortIcon = sortDirection === "asc" ? ArrowUp : ArrowDown;

  return (
    <div className="space-y-6">
      {confirmDialog}
      <AdminPageHeader
        title="Lockers"
        description="Create lockers and optionally allocate them to members."
      />

      <div className="max-w-xs">
        <LodgeSelect lodges={lodges} value={lodgeId} onChange={setLodgeId} loading={lodgesLoading} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{editingLockerId ? "Edit Locker" : "New Locker"}</CardTitle>
          <CardDescription>
            {editingLockerId
              ? "Update the locker name or member allocation."
              : "Add a locker name and optionally assign it to a member."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleFormSubmit}
            className="grid gap-4 sm:grid-cols-3"
          >
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="locker-name">Name</Label>
              <Input
                id="locker-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Locker A1"
                required
              />
            </div>
            <div className="space-y-1 sm:col-span-1">
              <Label htmlFor="locker-allocated">Allocated To</Label>
              <Select
                value={allocatedToMemberId}
                onValueChange={(value) => {
                  setAllocatedToMemberId(value);
                  setAllocatedToSearch("");
                }}
              >
                <SelectTrigger id="locker-allocated">
                  <SelectValue placeholder="Unallocated" />
                </SelectTrigger>
                <SelectContent>
                  <div className="p-2">
                    <Input
                      value={allocatedToSearch}
                      onChange={(event) =>
                        setAllocatedToSearch(event.target.value)
                      }
                      onKeyDown={handleAllocatedToSearchKeyDown}
                      placeholder="Search member"
                      className="h-8"
                    />
                  </div>
                  <SelectItem value="UNALLOCATED">Unallocated</SelectItem>
                  {filteredMembers.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {memberDisplayName(member)}
                    </SelectItem>
                  ))}
                  {filteredMembers.length === 0 ? (
                    <div className="px-2 pb-2 text-xs text-muted-foreground">
                      No members found.
                    </div>
                  ) : null}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-2 sm:col-span-1">
              <Button
                type="submit"
                disabled={saving}
                className="w-full sm:w-auto"
              >
                {saving
                  ? "Saving..."
                  : editingLockerId
                    ? "Update Locker"
                    : "Create Locker"}
              </Button>
              {editingLockerId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={resetForm}
                  disabled={saving}
                  aria-label="Cancel locker edit"
                  title="Cancel locker edit"
                >
                  <X className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </form>
          {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quick Add Lockers</CardTitle>
          <CardDescription>
            Seed several unallocated lockers at once, then rename or allocate
            them individually.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="bulk-locker-count">How many</Label>
              <Input
                id="bulk-locker-count"
                type="number"
                min={1}
                max={100}
                placeholder="12"
                value={bulkCount}
                onChange={(event) => setBulkCount(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bulk-locker-prefix">Name prefix</Label>
              <Input
                id="bulk-locker-prefix"
                value={bulkNamePrefix}
                onChange={(event) => setBulkNamePrefix(event.target.value)}
                placeholder="Locker"
              />
            </div>
            <div className="flex items-end">
              <Button
                type="button"
                onClick={() => void bulkCreateLockers()}
                disabled={bulkSaving || !bulkCount || Number(bulkCount) < 1}
                className="w-full sm:w-auto"
              >
                {bulkSaving ? "Creating..." : "Create Lockers"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Locker List</CardTitle>
          <CardDescription>
            Sort by locker name or allocated member.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading lockers...</p>
          ) : sortedLockers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No lockers created yet.</p>
          ) : (
            <AdminDataTable>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-semibold"
                      onClick={() => toggleSort("name")}
                    >
                      Name
                      {sortField === "name" ? (
                        <SortIcon className="h-3.5 w-3.5" />
                      ) : null}
                    </button>
                  </TableHead>
                  <TableHead>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-semibold"
                      onClick={() => toggleSort("allocatedTo")}
                    >
                      Allocated To
                      {sortField === "allocatedTo" ? (
                        <SortIcon className="h-3.5 w-3.5" />
                      ) : null}
                    </button>
                  </TableHead>
                  <TableHead className="text-right font-semibold">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLockers.map((locker) => (
                  <TableRow key={locker.id}>
                    <TableCell className="font-medium">{locker.name}</TableCell>
                    <TableCell>
                      {memberDisplayName(locker.allocatedTo)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => beginEdit(locker)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          aria-label={`Edit locker ${locker.name}`}
                          title="Edit locker"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteLocker(locker)}
                          disabled={deletingLockerId === locker.id}
                          className="inline-flex h-8 w-8 items-center justify-center rounded border border-danger/30 text-danger transition-colors hover:bg-danger-muted disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Delete locker ${locker.name}`}
                          title="Delete locker"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </AdminDataTable>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
