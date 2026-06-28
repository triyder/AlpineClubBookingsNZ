"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Eye,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { getSeasonYear } from "@/lib/utils";

type BookingBehavior = "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
type SubscriptionBehavior = "REQUIRED" | "NOT_REQUIRED";

interface MembershipType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  isBuiltIn: boolean;
  bookingBehavior: BookingBehavior;
  subscriptionBehavior: SubscriptionBehavior;
  sortOrder: number;
  assignmentCount: number;
}

interface MembershipTypesResponse {
  membershipTypes: MembershipType[];
}

interface RollForwardException {
  code: "missing_prior_assignment" | "inactive_membership_type";
  memberId: string;
  memberName: string;
  memberEmail: string;
  membershipTypeName?: string;
}

interface RollForwardResponse {
  fromSeasonYear: number;
  toSeasonYear: number;
  dryRun: boolean;
  sourceAssignmentCount: number;
  wouldCopyCount: number;
  copiedCount: number;
  skippedExistingCount: number;
  exceptionCount: number;
  exceptions: RollForwardException[];
}

interface DraftMembershipType {
  name: string;
  description: string;
  isActive: boolean;
  bookingBehavior: BookingBehavior;
  subscriptionBehavior: SubscriptionBehavior;
}

const bookingBehaviorLabels: Record<BookingBehavior, string> = {
  MEMBER_RATE: "Member rate",
  NON_MEMBER_RATE: "Non-member rate",
  BLOCK_BOOKING: "Block booking",
};

const subscriptionBehaviorLabels: Record<SubscriptionBehavior, string> = {
  REQUIRED: "Subscription required",
  NOT_REQUIRED: "Subscription not required",
};

const emptyDraft: DraftMembershipType = {
  name: "",
  description: "",
  isActive: true,
  bookingBehavior: "MEMBER_RATE",
  subscriptionBehavior: "REQUIRED",
};

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function draftFromType(type: MembershipType): DraftMembershipType {
  return {
    name: type.name,
    description: type.description ?? "",
    isActive: type.isActive,
    bookingBehavior: type.bookingBehavior,
    subscriptionBehavior: type.subscriptionBehavior,
  };
}

function isDirty(type: MembershipType, draft: DraftMembershipType) {
  return (
    type.name !== draft.name ||
    (type.description ?? "") !== draft.description ||
    type.isActive !== draft.isActive ||
    type.bookingBehavior !== draft.bookingBehavior ||
    type.subscriptionBehavior !== draft.subscriptionBehavior
  );
}

function formatSeasonLabel(seasonYear: number) {
  return `${seasonYear}/${seasonYear + 1}`;
}

function rollForwardExceptionLabel(exception: RollForwardException) {
  if (exception.code === "inactive_membership_type") {
    return `Inactive type${exception.membershipTypeName ? `: ${exception.membershipTypeName}` : ""}`;
  }
  return "Missing prior assignment";
}

export default function AdminMembershipTypesPage() {
  const defaultSeasonYear = getSeasonYear(new Date());
  const [membershipTypes, setMembershipTypes] = useState<MembershipType[]>([]);
  const [drafts, setDrafts] = useState<Record<string, DraftMembershipType>>({});
  const [newDraft, setNewDraft] = useState<DraftMembershipType>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [rollForwardFromSeasonYear, setRollForwardFromSeasonYear] =
    useState(defaultSeasonYear);
  const [rollForwardToSeasonYear, setRollForwardToSeasonYear] = useState(
    defaultSeasonYear + 1,
  );
  const [rollForwardMode, setRollForwardMode] = useState<
    "preview" | "run" | null
  >(null);
  const [rollForwardResult, setRollForwardResult] =
    useState<RollForwardResponse | null>(null);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");

  const sortedTypes = useMemo(
    () =>
      [...membershipTypes].sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) {
          return left.sortOrder - right.sortOrder;
        }
        return left.name.localeCompare(right.name);
      }),
    [membershipTypes],
  );

  async function loadMembershipTypes() {
    setLoading(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/membership-types", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as
        | MembershipTypesResponse
        | { error?: string };
      if (!response.ok || !("membershipTypes" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to load membership types"),
        );
      }
      setMembershipTypes(body.membershipTypes);
      setDrafts(
        Object.fromEntries(
          body.membershipTypes.map((type) => [type.id, draftFromType(type)]),
        ),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load membership types",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMembershipTypes();
  }, []);

  function updateDraft(id: string, patch: Partial<DraftMembershipType>) {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
    setSavedMessage("");
  }

  async function createMembershipType() {
    setCreating(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/membership-types", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newDraft),
      });
      const body = (await response.json()) as
        | { membershipType: MembershipType }
        | { error?: string };
      if (!response.ok || !("membershipType" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to create membership type"),
        );
      }
      setMembershipTypes((current) => [...current, body.membershipType]);
      setDrafts((current) => ({
        ...current,
        [body.membershipType.id]: draftFromType(body.membershipType),
      }));
      setNewDraft(emptyDraft);
      setSavedMessage("Membership type created.");
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : "Failed to create membership type",
      );
    } finally {
      setCreating(false);
    }
  }

  async function saveMembershipType(
    type: MembershipType,
    overrideDraft?: DraftMembershipType,
  ) {
    const draft = overrideDraft ?? drafts[type.id];
    if (!draft) return;

    setSavingId(type.id);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch(`/api/admin/membership-types/${type.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await response.json()) as
        | { membershipType: MembershipType }
        | { error?: string };
      if (!response.ok || !("membershipType" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to save membership type"),
        );
      }
      setMembershipTypes((current) =>
        current.map((item) =>
          item.id === body.membershipType.id ? body.membershipType : item,
        ),
      );
      setDrafts((current) => ({
        ...current,
        [body.membershipType.id]: draftFromType(body.membershipType),
      }));
      setSavedMessage("Membership type saved.");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save membership type",
      );
    } finally {
      setSavingId(null);
    }
  }

  async function setActive(type: MembershipType, isActive: boolean) {
    const draft = {
      ...(drafts[type.id] ?? draftFromType(type)),
      isActive,
    };
    setDrafts((current) => ({
      ...current,
      [type.id]: draft,
    }));
    setSavedMessage("");
    await saveMembershipType(type, draft);
  }

  async function reorder(nextOrder: MembershipType[]) {
    setReordering(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/membership-types/reorder", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds: nextOrder.map((type) => type.id) }),
      });
      const body = (await response.json()) as
        | MembershipTypesResponse
        | { error?: string };
      if (!response.ok || !("membershipTypes" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to reorder membership types"),
        );
      }
      setMembershipTypes(body.membershipTypes);
      setDrafts(
        Object.fromEntries(
          body.membershipTypes.map((type) => [type.id, draftFromType(type)]),
        ),
      );
      setSavedMessage("Membership type order saved.");
    } catch (reorderError) {
      setError(
        reorderError instanceof Error
          ? reorderError.message
          : "Failed to reorder membership types",
      );
    } finally {
      setReordering(false);
    }
  }

  function moveType(index: number, direction: -1 | 1) {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= sortedTypes.length) {
      return;
    }

    const next = [...sortedTypes];
    const [item] = next.splice(index, 1);
    next.splice(targetIndex, 0, item);
    void reorder(next);
  }

  async function rollForwardAssignments(dryRun: boolean) {
    setRollForwardMode(dryRun ? "preview" : "run");
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/membership-types/roll-forward", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromSeasonYear: rollForwardFromSeasonYear,
          toSeasonYear: rollForwardToSeasonYear,
          dryRun,
        }),
      });
      const body = (await response.json()) as
        | RollForwardResponse
        | { error?: string };
      if (!response.ok || !("wouldCopyCount" in body)) {
        throw new Error(
          responseErrorMessage(
            body,
            dryRun
              ? "Failed to preview seasonal assignment roll-forward"
              : "Failed to roll forward seasonal assignments",
          ),
        );
      }
      setRollForwardResult(body);
      if (!dryRun) {
        await loadMembershipTypes();
      }
      setSavedMessage(
        dryRun
          ? "Roll-forward preview ready."
          : `Rolled forward ${body.copiedCount} seasonal assignment${
              body.copiedCount === 1 ? "" : "s"
            }.`,
      );
    } catch (rollForwardError) {
      setError(
        rollForwardError instanceof Error
          ? rollForwardError.message
          : dryRun
            ? "Failed to preview seasonal assignment roll-forward"
            : "Failed to roll forward seasonal assignments",
      );
    } finally {
      setRollForwardMode(null);
    }
  }

  if (loading && membershipTypes.length === 0) {
    return (
      <div className="flex min-h-[320px] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-slate-500" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Membership types
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            Manage seasonal membership policy labels and future booking and
            subscription behavior. Access roles stay separate.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          onClick={() => void loadMembershipTypes()}
          disabled={loading || creating || reordering || savingId !== null}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
      </div>

      {(error || savedMessage) && (
        <div
          className={
            error
              ? "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              : "rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800"
          }
        >
          {error || savedMessage}
        </div>
      )}

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Roll forward seasonal assignments
            </h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-500">
              Copy missing member membership-type assignments from one season to
              the next. Existing target-season assignments are kept.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-[150px_150px_auto_auto] sm:items-end">
            <div className="space-y-2">
              <Label htmlFor="roll-forward-from-season">From season</Label>
              <Input
                id="roll-forward-from-season"
                type="number"
                min={2020}
                max={2040}
                value={rollForwardFromSeasonYear}
                onChange={(event) =>
                  setRollForwardFromSeasonYear(
                    Number.parseInt(event.target.value, 10) || 2020,
                  )
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="roll-forward-to-season">To season</Label>
              <Input
                id="roll-forward-to-season"
                type="number"
                min={2020}
                max={2040}
                value={rollForwardToSeasonYear}
                onChange={(event) =>
                  setRollForwardToSeasonYear(
                    Number.parseInt(event.target.value, 10) || 2020,
                  )
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void rollForwardAssignments(true)}
              disabled={
                rollForwardMode !== null ||
                rollForwardFromSeasonYear === rollForwardToSeasonYear
              }
            >
              {rollForwardMode === "preview" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Eye className="mr-2 h-4 w-4" />
              )}
              Preview
            </Button>
            <Button
              type="button"
              onClick={() => void rollForwardAssignments(false)}
              disabled={
                rollForwardMode !== null ||
                rollForwardFromSeasonYear === rollForwardToSeasonYear
              }
            >
              {rollForwardMode === "run" ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RotateCcw className="mr-2 h-4 w-4" />
              )}
              Run
            </Button>
          </div>
        </div>

        {rollForwardResult && (
          <div className="mt-4 space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-5">
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Seasons
                </div>
                <div className="mt-1 text-slate-900">
                  {formatSeasonLabel(rollForwardResult.fromSeasonYear)} to{" "}
                  {formatSeasonLabel(rollForwardResult.toSeasonYear)}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Source
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.sourceAssignmentCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Would copy
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.wouldCopyCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Copied
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.copiedCount}
                </div>
              </div>
              <div>
                <div className="text-xs font-medium uppercase text-slate-500">
                  Existing target
                </div>
                <div className="mt-1 text-slate-900">
                  {rollForwardResult.skippedExistingCount}
                </div>
              </div>
            </div>

            {rollForwardResult.exceptionCount > 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <div className="text-sm font-medium text-amber-900">
                  Exceptions ({rollForwardResult.exceptionCount})
                </div>
                <div className="mt-2 space-y-1">
                  {rollForwardResult.exceptions.slice(0, 10).map((exception) => (
                    <div
                      key={`${exception.code}-${exception.memberId}`}
                      className="text-xs text-amber-900"
                    >
                      {exception.memberName} ({exception.memberEmail}) -{" "}
                      {rollForwardExceptionLabel(exception)}
                    </div>
                  ))}
                </div>
                {rollForwardResult.exceptionCount > 10 && (
                  <p className="mt-2 text-xs text-amber-800">
                    {rollForwardResult.exceptionCount - 10} more not shown.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="rounded-md border border-slate-200 bg-white p-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_220px_220px_auto] lg:items-end">
          <div className="space-y-2">
            <Label htmlFor="membership-type-name">Name</Label>
            <Input
              id="membership-type-name"
              value={newDraft.name}
              onChange={(event) =>
                setNewDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              maxLength={120}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="membership-type-description">Description</Label>
            <Textarea
              id="membership-type-description"
              value={newDraft.description}
              onChange={(event) =>
                setNewDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              maxLength={1000}
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label>Booking behavior</Label>
            <Select
              value={newDraft.bookingBehavior}
              onValueChange={(value) =>
                setNewDraft((current) => ({
                  ...current,
                  bookingBehavior: value as BookingBehavior,
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(bookingBehaviorLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Subscription behavior</Label>
            <Select
              value={newDraft.subscriptionBehavior}
              onValueChange={(value) =>
                setNewDraft((current) => ({
                  ...current,
                  subscriptionBehavior: value as SubscriptionBehavior,
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(subscriptionBehaviorLabels).map(
                  ([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>

          <Button
            type="button"
            onClick={() => void createMembershipType()}
            disabled={creating || newDraft.name.trim().length === 0}
          >
            {creating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            Add
          </Button>
        </div>
      </section>

      <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[220px]">Name</TableHead>
              <TableHead className="min-w-[260px]">Description</TableHead>
              <TableHead className="min-w-[190px]">Booking</TableHead>
              <TableHead className="min-w-[210px]">Subscription</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assignments</TableHead>
              <TableHead className="w-[180px]">Order</TableHead>
              <TableHead className="w-[210px] text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedTypes.map((type, index) => {
              const draft = drafts[type.id] ?? draftFromType(type);
              const rowDirty = isDirty(type, draft);

              return (
                <TableRow key={type.id}>
                  <TableCell className="align-top">
                    <div className="space-y-2">
                      <Input
                        value={draft.name}
                        onChange={(event) =>
                          updateDraft(type.id, { name: event.target.value })
                        }
                        maxLength={120}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Badge variant={type.isBuiltIn ? "default" : "secondary"}>
                          {type.isBuiltIn ? "Built-in" : "Custom"}
                        </Badge>
                        <Badge variant="outline">{type.key}</Badge>
                      </div>
                    </div>
                  </TableCell>

                  <TableCell className="align-top">
                    <Textarea
                      value={draft.description}
                      onChange={(event) =>
                        updateDraft(type.id, {
                          description: event.target.value,
                        })
                      }
                      maxLength={1000}
                      rows={3}
                    />
                  </TableCell>

                  <TableCell className="align-top">
                    <Select
                      value={draft.bookingBehavior}
                      onValueChange={(value) =>
                        updateDraft(type.id, {
                          bookingBehavior: value as BookingBehavior,
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(bookingBehaviorLabels).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  <TableCell className="align-top">
                    <Select
                      value={draft.subscriptionBehavior}
                      onValueChange={(value) =>
                        updateDraft(type.id, {
                          subscriptionBehavior: value as SubscriptionBehavior,
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(subscriptionBehaviorLabels).map(
                          ([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ),
                        )}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  <TableCell className="align-top">
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id={`membership-type-active-${type.id}`}
                        checked={draft.isActive}
                        onCheckedChange={(checked) =>
                          updateDraft(type.id, { isActive: checked === true })
                        }
                      />
                      <Label htmlFor={`membership-type-active-${type.id}`}>
                        Active
                      </Label>
                    </div>
                  </TableCell>

                  <TableCell className="align-top text-sm text-slate-600">
                    {type.assignmentCount}
                  </TableCell>

                  <TableCell className="align-top">
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => moveType(index, -1)}
                        disabled={index === 0 || reordering}
                        aria-label={`Move ${type.name} up`}
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => moveType(index, 1)}
                        disabled={index === sortedTypes.length - 1 || reordering}
                        aria-label={`Move ${type.name} down`}
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>

                  <TableCell className="align-top">
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void saveMembershipType(type)}
                        disabled={!rowDirty || savingId === type.id}
                      >
                        {savingId === type.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Save className="mr-2 h-4 w-4" />
                        )}
                        Save
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void setActive(type, !type.isActive)}
                        disabled={savingId === type.id}
                      >
                        {type.isActive ? (
                          <Archive className="mr-2 h-4 w-4" />
                        ) : (
                          <RotateCcw className="mr-2 h-4 w-4" />
                        )}
                        {type.isActive ? "Archive" : "Reactivate"}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
