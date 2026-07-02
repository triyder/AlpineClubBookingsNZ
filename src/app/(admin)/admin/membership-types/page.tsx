"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
  X,
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
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { getSeasonYear } from "@/lib/utils";

type BookingBehavior = "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
type SubscriptionBehavior = "REQUIRED" | "NOT_REQUIRED";
type AgeTier = "INFANT" | "CHILD" | "YOUTH" | "ADULT";
type XeroContactGroupRuleMode = "MANAGED" | "ACCEPTED";

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
  allowedAgeTiers: AgeTier[];
  xeroContactGroupRules: Array<{
    id: string;
    ageTier: AgeTier | null;
    mode: XeroContactGroupRuleMode;
    groupId: string;
    groupName: string | null;
    isActive: boolean;
    sortOrder: number;
  }>;
}

interface XeroContactGroup {
  id: string;
  name: string;
  contactCount: number;
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
  allowedAgeTiers: AgeTier[];
  xeroContactGroupRules: DraftXeroContactGroupRule[];
}

interface DraftXeroContactGroupRule {
  draftId: string;
  ageTier: AgeTier | null;
  mode: XeroContactGroupRuleMode;
  groupId: string;
  groupName: string;
  isActive: boolean;
  sortOrder: number;
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

const ageTierLabels: Record<AgeTier, string> = {
  INFANT: "Infant",
  CHILD: "Child",
  YOUTH: "Youth",
  ADULT: "Adult",
};

const xeroRuleModeLabels: Record<XeroContactGroupRuleMode, string> = {
  MANAGED: "Managed",
  ACCEPTED: "Accepted",
};

const ageTierOrder: AgeTier[] = ["INFANT", "CHILD", "YOUTH", "ADULT"];
const allAgeTierValue = "__all__";
const noXeroGroupValue = "__none__";

function createEmptyDraft(): DraftMembershipType {
  return {
    name: "",
    description: "",
    isActive: true,
    bookingBehavior: "MEMBER_RATE",
    subscriptionBehavior: "REQUIRED",
    allowedAgeTiers: [...ageTierOrder],
    xeroContactGroupRules: [],
  };
}

function nextDraftRuleId() {
  return `draft-rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

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
    allowedAgeTiers: [...type.allowedAgeTiers],
    xeroContactGroupRules: type.xeroContactGroupRules.map((rule) => ({
      draftId: rule.id,
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId,
      groupName: rule.groupName ?? "",
      isActive: rule.isActive,
      sortOrder: rule.sortOrder,
    })),
  };
}

function comparableDraft(draft: DraftMembershipType) {
  return {
    ...draft,
    description: draft.description.trim(),
    allowedAgeTiers: ageTierOrder.filter((ageTier) =>
      draft.allowedAgeTiers.includes(ageTier),
    ),
    xeroContactGroupRules: draft.xeroContactGroupRules.map((rule, index) => ({
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId.trim(),
      groupName: rule.groupName.trim(),
      isActive: rule.isActive,
      sortOrder: rule.sortOrder ?? index,
    })),
  };
}

function isDirty(type: MembershipType, draft: DraftMembershipType) {
  return JSON.stringify(comparableDraft(draftFromType(type))) !==
    JSON.stringify(comparableDraft(draft));
}

function validateDraft(draft: DraftMembershipType): string | null {
  if (draft.allowedAgeTiers.length === 0) {
    return "Select at least one allowed age tier.";
  }
  if (
    draft.xeroContactGroupRules.some((rule) => rule.groupId.trim().length === 0)
  ) {
    return "Every Xero group rule needs a group.";
  }
  return null;
}

function draftPayload(draft: DraftMembershipType) {
  return {
    name: draft.name,
    description: draft.description,
    isActive: draft.isActive,
    bookingBehavior: draft.bookingBehavior,
    subscriptionBehavior: draft.subscriptionBehavior,
    allowedAgeTiers: ageTierOrder.filter((ageTier) =>
      draft.allowedAgeTiers.includes(ageTier),
    ),
    xeroContactGroupRules: draft.xeroContactGroupRules.map((rule, index) => ({
      ageTier: rule.ageTier,
      mode: rule.mode,
      groupId: rule.groupId,
      groupName: rule.groupName || null,
      isActive: rule.isActive,
      sortOrder: index,
    })),
  };
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
  const [newDraft, setNewDraft] = useState<DraftMembershipType>(
    createEmptyDraft,
  );
  const [xeroGroups, setXeroGroups] = useState<XeroContactGroup[]>([]);
  const [loadingXeroGroups, setLoadingXeroGroups] = useState(true);
  const [refreshingXeroGroups, setRefreshingXeroGroups] = useState(false);
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
  const pageRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const { scrollToError, scrollToTop } = useScrollToFeedback();

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

  useEffect(() => {
    if (error) scrollToError(feedbackRef);
  }, [error, scrollToError]);

  useEffect(() => {
    if (savedMessage) scrollToTop(pageRef);
  }, [savedMessage, scrollToTop]);

  async function loadXeroGroups(refreshFromXero = false) {
    if (refreshFromXero) {
      setRefreshingXeroGroups(true);
    } else {
      setLoadingXeroGroups(true);
    }
    setError("");

    try {
      const response = await fetch(
        `/api/admin/xero/contact-groups${refreshFromXero ? "?refresh=1" : ""}`,
        { credentials: "same-origin" },
      );
      const body = (await response.json().catch(() => null)) as
        | { groups?: XeroContactGroup[]; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to load Xero contact groups");
      }
      setXeroGroups(body?.groups ?? []);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load Xero contact groups",
      );
    } finally {
      setLoadingXeroGroups(false);
      setRefreshingXeroGroups(false);
    }
  }

  useEffect(() => {
    void loadXeroGroups();
  }, []);

  function updateDraft(id: string, patch: Partial<DraftMembershipType>) {
    setDrafts((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
    setSavedMessage("");
  }

  function toggleNewDraftAgeTier(ageTier: AgeTier, checked: boolean) {
    setNewDraft((current) => ({
      ...current,
      allowedAgeTiers: checked
        ? ageTierOrder.filter((tier) =>
            [...current.allowedAgeTiers, ageTier].includes(tier),
          )
        : current.allowedAgeTiers.filter((tier) => tier !== ageTier),
    }));
    setSavedMessage("");
  }

  function toggleDraftAgeTier(id: string, ageTier: AgeTier, checked: boolean) {
    setDrafts((current) => {
      const draft = current[id];
      if (!draft) return current;
      return {
        ...current,
        [id]: {
          ...draft,
          allowedAgeTiers: checked
            ? ageTierOrder.filter((tier) =>
                [...draft.allowedAgeTiers, ageTier].includes(tier),
              )
            : draft.allowedAgeTiers.filter((tier) => tier !== ageTier),
        },
      };
    });
    setSavedMessage("");
  }

  function addDraftXeroRule(id: string) {
    setDrafts((current) => {
      const draft = current[id];
      if (!draft) return current;
      return {
        ...current,
        [id]: {
          ...draft,
          xeroContactGroupRules: [
            ...draft.xeroContactGroupRules,
            {
              draftId: nextDraftRuleId(),
              ageTier: null,
              mode: "MANAGED",
              groupId: "",
              groupName: "",
              isActive: true,
              sortOrder: draft.xeroContactGroupRules.length,
            },
          ],
        },
      };
    });
    setSavedMessage("");
  }

  function updateDraftXeroRule(
    id: string,
    draftRuleId: string,
    patch: Partial<DraftXeroContactGroupRule>,
  ) {
    setDrafts((current) => {
      const draft = current[id];
      if (!draft) return current;
      return {
        ...current,
        [id]: {
          ...draft,
          xeroContactGroupRules: draft.xeroContactGroupRules.map((rule) =>
            rule.draftId === draftRuleId ? { ...rule, ...patch } : rule,
          ),
        },
      };
    });
    setSavedMessage("");
  }

  function removeDraftXeroRule(id: string, draftRuleId: string) {
    setDrafts((current) => {
      const draft = current[id];
      if (!draft) return current;
      return {
        ...current,
        [id]: {
          ...draft,
          xeroContactGroupRules: draft.xeroContactGroupRules.filter(
            (rule) => rule.draftId !== draftRuleId,
          ),
        },
      };
    });
    setSavedMessage("");
  }

  async function createMembershipType() {
    setCreating(true);
    setError("");
    setSavedMessage("");

    try {
      const validationError = validateDraft(newDraft);
      if (validationError) {
        throw new Error(validationError);
      }
      const response = await fetch("/api/admin/membership-types", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(newDraft)),
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
      setNewDraft(createEmptyDraft());
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
      const validationError = validateDraft(draft);
      if (validationError) {
        throw new Error(validationError);
      }
      const response = await fetch(`/api/admin/membership-types/${type.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftPayload(draft)),
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
    <div ref={pageRef} className="space-y-8">
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

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadXeroGroups(true)}
            disabled={refreshingXeroGroups}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${refreshingXeroGroups ? "animate-spin" : ""}`}
            />
            {refreshingXeroGroups ? "Refreshing Xero" : "Refresh Xero Groups"}
          </Button>
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
      </div>

      {(error || savedMessage) && (
        <div
          ref={feedbackRef}
          role={error ? "alert" : "status"}
          tabIndex={error ? -1 : undefined}
          className={
            error
              ? "scroll-mt-20 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 focus:outline-none"
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
        <div className="mt-4 space-y-2">
          <Label>Allowed age tiers</Label>
          <div className="flex flex-wrap gap-2">
            {ageTierOrder.map((ageTier) => {
              const inputId = `new-membership-type-age-${ageTier}`;
              return (
                <label
                  key={ageTier}
                  htmlFor={inputId}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm"
                >
                  <Checkbox
                    id={inputId}
                    checked={newDraft.allowedAgeTiers.includes(ageTier)}
                    onCheckedChange={(checked) =>
                      toggleNewDraftAgeTier(ageTier, checked === true)
                    }
                  />
                  {ageTierLabels[ageTier]}
                </label>
              );
            })}
          </div>
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
              <TableHead className="min-w-[250px]">Age Tiers</TableHead>
              <TableHead className="min-w-[560px]">Xero Groups</TableHead>
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
                    <div className="grid grid-cols-2 gap-2">
                      {ageTierOrder.map((ageTier) => {
                        const inputId = `membership-type-${type.id}-age-${ageTier}`;
                        return (
                          <label
                            key={ageTier}
                            htmlFor={inputId}
                            className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-2 py-1.5 text-sm"
                          >
                            <Checkbox
                              id={inputId}
                              checked={draft.allowedAgeTiers.includes(ageTier)}
                              onCheckedChange={(checked) =>
                                toggleDraftAgeTier(
                                  type.id,
                                  ageTier,
                                  checked === true,
                                )
                              }
                            />
                            {ageTierLabels[ageTier]}
                          </label>
                        );
                      })}
                    </div>
                  </TableCell>

                  <TableCell className="align-top">
                    <div className="space-y-2">
                      {draft.xeroContactGroupRules.length === 0 ? (
                        <p className="text-xs text-slate-500">
                          No membership-type Xero rules.
                        </p>
                      ) : (
                        draft.xeroContactGroupRules.map((rule) => {
                          const selectedGroup = xeroGroups.find(
                            (group) => group.id === rule.groupId,
                          );
                          const groupSelectId = `membership-type-${type.id}-xero-group-${rule.draftId}`;
                          const modeSelectId = `membership-type-${type.id}-xero-mode-${rule.draftId}`;
                          const ageSelectId = `membership-type-${type.id}-xero-age-${rule.draftId}`;
                          const activeInputId = `membership-type-${type.id}-xero-active-${rule.draftId}`;

                          return (
                            <div
                              key={rule.draftId}
                              className="grid gap-2 rounded-md border border-slate-200 p-2 lg:grid-cols-[110px_120px_minmax(180px,1fr)_90px_36px]"
                            >
                              <div className="space-y-1">
                                <Label htmlFor={modeSelectId}>Mode</Label>
                                <Select
                                  value={rule.mode}
                                  onValueChange={(value) =>
                                    updateDraftXeroRule(type.id, rule.draftId, {
                                      mode: value as XeroContactGroupRuleMode,
                                    })
                                  }
                                >
                                  <SelectTrigger id={modeSelectId}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {Object.entries(xeroRuleModeLabels).map(
                                      ([value, label]) => (
                                        <SelectItem key={value} value={value}>
                                          {label}
                                        </SelectItem>
                                      ),
                                    )}
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="space-y-1">
                                <Label htmlFor={ageSelectId}>Age</Label>
                                <Select
                                  value={rule.ageTier ?? allAgeTierValue}
                                  onValueChange={(value) =>
                                    updateDraftXeroRule(type.id, rule.draftId, {
                                      ageTier:
                                        value === allAgeTierValue
                                          ? null
                                          : (value as AgeTier),
                                    })
                                  }
                                >
                                  <SelectTrigger id={ageSelectId}>
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={allAgeTierValue}>
                                      All ages
                                    </SelectItem>
                                    {ageTierOrder.map((ageTier) => (
                                      <SelectItem key={ageTier} value={ageTier}>
                                        {ageTierLabels[ageTier]}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="space-y-1">
                                <Label htmlFor={groupSelectId}>Group</Label>
                                <Select
                                  value={rule.groupId || noXeroGroupValue}
                                  onValueChange={(value) => {
                                    if (value === noXeroGroupValue) {
                                      updateDraftXeroRule(
                                        type.id,
                                        rule.draftId,
                                        { groupId: "", groupName: "" },
                                      );
                                      return;
                                    }
                                    const group = xeroGroups.find(
                                      (candidate) => candidate.id === value,
                                    );
                                    updateDraftXeroRule(type.id, rule.draftId, {
                                      groupId: value,
                                      groupName: group?.name ?? rule.groupName,
                                    });
                                  }}
                                  disabled={loadingXeroGroups}
                                >
                                  <SelectTrigger id={groupSelectId}>
                                    <SelectValue placeholder="Select group" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value={noXeroGroupValue}>
                                      Select group
                                    </SelectItem>
                                    {rule.groupId && !selectedGroup ? (
                                      <SelectItem value={rule.groupId}>
                                        {rule.groupName || rule.groupId}
                                      </SelectItem>
                                    ) : null}
                                    {xeroGroups.map((group) => (
                                      <SelectItem key={group.id} value={group.id}>
                                        {group.name} ({group.contactCount})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>

                              <div className="flex items-end gap-2 pb-2">
                                <Checkbox
                                  id={activeInputId}
                                  checked={rule.isActive}
                                  onCheckedChange={(checked) =>
                                    updateDraftXeroRule(type.id, rule.draftId, {
                                      isActive: checked === true,
                                    })
                                  }
                                />
                                <Label htmlFor={activeInputId}>Active</Label>
                              </div>

                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="self-end"
                                onClick={() =>
                                  removeDraftXeroRule(type.id, rule.draftId)
                                }
                                aria-label="Remove Xero group rule"
                              >
                                <X className="h-4 w-4" />
                              </Button>
                            </div>
                          );
                        })
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => addDraftXeroRule(type.id)}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add Xero Rule
                      </Button>
                    </div>
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
