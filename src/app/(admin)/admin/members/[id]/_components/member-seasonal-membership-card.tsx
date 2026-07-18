"use client";

import { useEffect, useMemo, useState } from "react";
import { Eye, Loader2, RefreshCw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ROLE_LABELS } from "@/lib/member-roles";
import { formatCents, getSeasonYear } from "@/lib/utils";
import type {
  MembershipTypeSummary,
  MemberDetail,
  SeasonalMembershipAssignmentSummary,
} from "../_types";

type BookingBehavior = "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
type SubscriptionBehavior = "REQUIRED" | "NOT_REQUIRED" | "BASED_ON_AGE_TIER";

interface MembershipTypesResponse {
  membershipTypes: MembershipTypeSummary[];
}

interface PreviewBookingSummary {
  count: number;
  truncatedCount: number;
  list: Array<{
    id: string;
    checkIn: string;
    checkOut: string;
    status: string;
    finalPriceCents: number;
    guestCount: number;
    waitlistPosition: number | null;
    waitlistOfferExpiresAt: string | null;
  }>;
}

interface SeasonalMembershipPreview {
  seasonYear: number;
  applyFrom: string | null;
  previousAssignment: SeasonalMembershipAssignmentSummary | null;
  newMembershipType: MembershipTypeSummary;
  resultingBookingBehavior: BookingBehavior;
  resultingSubscriptionBehavior: SubscriptionBehavior;
  behaviorChanged: boolean;
  bookingBehaviorChanged: boolean;
  subscriptionBehaviorChanged: boolean;
  affectedCounts: {
    futureConfirmedBookings: number;
    draftBookings: number;
    waitlistRecords: number;
  };
  futureConfirmedBookings: PreviewBookingSummary;
  draftBookings: PreviewBookingSummary;
  waitlistRecords: PreviewBookingSummary;
  currentSeasonSubscription: {
    seasonYear: number;
    status: string;
    hasInvoice: boolean;
    xeroInvoiceNumber: string | null;
    paidAt: string | null;
  };
  subscriptionHistory: {
    totalRecords: number;
    recent: Array<{
      seasonYear: number;
      status: string;
      hasInvoice: boolean;
      xeroInvoiceNumber: string | null;
      paidAt: string | null;
    }>;
  };
  previewToken: string;
}

interface MemberSeasonalMembershipCardProps {
  member: MemberDetail;
  onSaved: () => Promise<void>;
  className?: string;
}

const bookingBehaviorLabels: Record<BookingBehavior, string> = {
  MEMBER_RATE: "Member rate",
  NON_MEMBER_RATE: "Non-member rate",
  BLOCK_BOOKING: "Block booking",
};

const subscriptionBehaviorLabels: Record<SubscriptionBehavior, string> = {
  REQUIRED: "Required",
  NOT_REQUIRED: "Not required",
  BASED_ON_AGE_TIER: "Based on age tier",
};

const EMPTY_SEASONAL_ASSIGNMENTS: SeasonalMembershipAssignmentSummary[] = [];

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

function formatSeasonLabel(seasonYear: number) {
  return `${seasonYear}/${seasonYear + 1}`;
}

function formatDate(date: string | null) {
  return date ? new Date(date).toLocaleDateString("en-NZ") : "-";
}

function BookingSummaryBlock({
  title,
  summary,
}: {
  title: string;
  summary: PreviewBookingSummary;
}) {
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-slate-900">{title}</h3>
        <Badge variant="secondary">{summary.count}</Badge>
      </div>
      {summary.count === 0 ? (
        <p className="mt-2 text-xs text-slate-500">None</p>
      ) : (
        <div className="mt-2 space-y-2">
          {summary.list.map((booking) => (
            <div key={booking.id} className="text-xs text-slate-600">
              <span className="font-medium text-slate-800">
                {formatDate(booking.checkIn)} to {formatDate(booking.checkOut)}
              </span>{" "}
              - {booking.status} - {booking.guestCount} guest
              {booking.guestCount === 1 ? "" : "s"} -{" "}
              {formatCents(booking.finalPriceCents)}
              {booking.waitlistPosition
                ? ` - position ${booking.waitlistPosition}`
                : ""}
            </div>
          ))}
          {summary.truncatedCount > 0 && (
            <p className="text-xs text-slate-500">
              {summary.truncatedCount} more not shown
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function MemberSeasonalMembershipCard({
  member,
  onSaved,
  className,
}: MemberSeasonalMembershipCardProps) {
  // Saving a change writes /api/admin/members/[id]/seasonal-membership
  // (membership area); a view-only membership admin may still preview but
  // cannot commit the change (#1997).
  const canEdit = useAdminAreaEditAccess("membership");
  const [membershipTypes, setMembershipTypes] = useState<
    MembershipTypeSummary[]
  >([]);
  const effectiveCurrentSeasonYear =
    member.currentSeasonYear ?? getSeasonYear(new Date());
  const seasonalAssignments =
    member.seasonalMembershipAssignments ?? EMPTY_SEASONAL_ASSIGNMENTS;
  const [typesLoading, setTypesLoading] = useState(true);
  const [seasonYear, setSeasonYear] = useState(effectiveCurrentSeasonYear);
  const [selectedMembershipTypeId, setSelectedMembershipTypeId] = useState("");
  const [applyFrom, setApplyFrom] = useState("");
  const [preview, setPreview] = useState<SeasonalMembershipPreview | null>(null);
  const [reason, setReason] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const currentAssignment = useMemo(
    () =>
      seasonalAssignments.find(
        (assignment) => assignment.seasonYear === seasonYear,
      ) ?? null,
    [seasonalAssignments, seasonYear],
  );

  const selectedMembershipType = membershipTypes.find(
    (type) => type.id === selectedMembershipTypeId,
  );
  const targetChanged =
    selectedMembershipTypeId.length > 0 &&
    (currentAssignment?.membershipTypeId !== selectedMembershipTypeId ||
      (currentAssignment?.applyFrom ?? "") !== applyFrom);

  async function loadMembershipTypes() {
    setTypesLoading(true);
    setError("");
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
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load membership types",
      );
    } finally {
      setTypesLoading(false);
    }
  }

  useEffect(() => {
    void loadMembershipTypes();
  }, []);

  useEffect(() => {
    setSeasonYear(effectiveCurrentSeasonYear);
    setApplyFrom("");
    setPreview(null);
    setReason("");
    setMessage("");
    setError("");
  }, [member.id, effectiveCurrentSeasonYear]);

  useEffect(() => {
    const activeFallback = membershipTypes.find((type) => type.isActive);
    setSelectedMembershipTypeId(
      currentAssignment?.membershipTypeId ?? activeFallback?.id ?? "",
    );
    setApplyFrom(currentAssignment?.applyFrom ?? "");
  }, [
    currentAssignment?.applyFrom,
    currentAssignment?.membershipTypeId,
    membershipTypes,
    seasonYear,
  ]);

  useEffect(() => {
    setPreview(null);
    setReason("");
    setMessage("");
  }, [member.id, seasonYear, selectedMembershipTypeId]);

  async function previewChange() {
    if (!selectedMembershipTypeId) {
      setError("Select a membership type");
      return;
    }

    setPreviewing(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/members/${member.id}/seasonal-membership/preview`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seasonYear,
            membershipTypeId: selectedMembershipTypeId,
            applyFrom: applyFrom || null,
          }),
        },
      );
      const body = (await response.json()) as
        | { preview: SeasonalMembershipPreview }
        | { error?: string };
      if (!response.ok || !("preview" in body)) {
        throw new Error(
          responseErrorMessage(body, "Failed to preview membership change"),
        );
      }
      setPreview(body.preview);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "Failed to preview membership change",
      );
    } finally {
      setPreviewing(false);
    }
  }

  async function saveChange() {
    if (!preview) {
      setError("Preview the membership type change before saving");
      return;
    }
    if (!reason.trim()) {
      setError("Admin reason is required");
      return;
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/members/${member.id}/seasonal-membership`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            seasonYear,
            membershipTypeId: selectedMembershipTypeId,
            applyFrom: applyFrom || null,
            reason,
            previewToken: preview.previewToken,
          }),
        },
      );
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(
          responseErrorMessage(body, "Failed to save membership change"),
        );
      }
      setPreview(null);
      setReason("");
      setMessage("Seasonal membership type saved.");
      await onSaved();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save membership change",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base font-medium">
          Seasonal Membership
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canEdit ? (
          <AdminViewOnlyNotice>
            Your admin role can view the seasonal membership type but cannot
            preview or change it.
          </AdminViewOnlyNotice>
        ) : null}
        {(error || message) && (
          <div
            className={
              error
                ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
                : "rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
            }
          >
            {error || message}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[160px_minmax(0,1fr)_180px_auto] lg:items-end">
          <div className="space-y-2">
            <Label htmlFor="seasonal-membership-season">Season</Label>
            <Input
              id="seasonal-membership-season"
              type="number"
              min={2020}
              max={2040}
              value={seasonYear}
              onChange={(event) =>
                setSeasonYear(Number.parseInt(event.target.value, 10) || 2020)
              }
            />
          </div>

          <div className="space-y-2">
            <Label>Membership Type</Label>
            <Select
              value={selectedMembershipTypeId}
              onValueChange={setSelectedMembershipTypeId}
              disabled={typesLoading}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select membership type" />
              </SelectTrigger>
              <SelectContent>
                {membershipTypes.map((type) => (
                  <SelectItem
                    key={type.id}
                    value={type.id}
                    disabled={!type.isActive && type.id !== currentAssignment?.membershipTypeId}
                  >
                    {type.name}
                    {!type.isActive ? " (archived)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="seasonal-membership-apply-from">Apply from</Label>
            <Input
              id="seasonal-membership-apply-from"
              type="date"
              value={applyFrom}
              onChange={(event) => setApplyFrom(event.target.value)}
            />
          </div>

          <ViewOnlyActionButton
            canEdit={canEdit}
            type="button"
            variant="outline"
            onClick={() => void previewChange()}
            disabled={previewing || typesLoading || !targetChanged}
          >
            {previewing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Eye className="mr-2 h-4 w-4" />
            )}
            Preview
          </ViewOnlyActionButton>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-slate-200 p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Access role
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Badge variant={member.role === "ADMIN" ? "default" : "secondary"}>
                {ROLE_LABELS[member.role]}
              </Badge>
            </div>
          </div>

          <div className="rounded-md border border-slate-200 p-3 text-sm">
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Current assignment
            </div>
            <div className="mt-1 font-medium text-slate-900">
              {currentAssignment
                ? `${currentAssignment.membershipType.name} for ${formatSeasonLabel(
                    currentAssignment.seasonYear,
                  )}`
                : `No assignment for ${formatSeasonLabel(seasonYear)}`}
            </div>
            {currentAssignment?.applyFrom && (
              <div className="mt-1 text-xs text-slate-500">
                Applies from {formatDate(currentAssignment.applyFrom)}
              </div>
            )}
          </div>
        </div>

        {selectedMembershipType && (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Resulting booking behavior
              </div>
              <div className="mt-1 font-medium text-slate-900">
                {bookingBehaviorLabels[selectedMembershipType.bookingBehavior]}
              </div>
            </div>
            <div className="rounded-md border border-slate-200 p-3 text-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Resulting subscription behavior
              </div>
              <div className="mt-1 font-medium text-slate-900">
                {
                  subscriptionBehaviorLabels[
                    selectedMembershipType.subscriptionBehavior
                  ]
                }
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadMembershipTypes()}
            disabled={typesLoading}
          >
            {typesLoading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            Refresh Types
          </Button>
        </div>

        {preview && (
          <div className="space-y-4 rounded-md border border-blue-200 bg-blue-50 p-4">
            <div className="grid gap-3 md:grid-cols-3">
              <BookingSummaryBlock
                title="Future confirmed"
                summary={preview.futureConfirmedBookings}
              />
              <BookingSummaryBlock
                title="Draft bookings"
                summary={preview.draftBookings}
              />
              <BookingSummaryBlock
                title="Waitlist records"
                summary={preview.waitlistRecords}
              />
            </div>

            <div className="rounded-md border border-blue-200 bg-white p-3 text-sm">
              <div className="font-medium text-slate-900">
                Subscription summary
              </div>
              <div className="mt-1 text-slate-600">
                Applies from {preview.applyFrom ? formatDate(preview.applyFrom) : "season start"}
              </div>
              <div className="mt-1 text-slate-600">
                {formatSeasonLabel(preview.currentSeasonSubscription.seasonYear)}
                : {preview.currentSeasonSubscription.status}
                {preview.currentSeasonSubscription.xeroInvoiceNumber
                  ? ` - invoice ${preview.currentSeasonSubscription.xeroInvoiceNumber}`
                  : ""}
                {preview.currentSeasonSubscription.paidAt
                  ? ` - paid ${formatDate(preview.currentSeasonSubscription.paidAt)}`
                  : ""}
              </div>
              {preview.subscriptionHistory.recent.length > 0 && (
                <div className="mt-2 text-xs text-slate-500">
                  Recent seasons:{" "}
                  {preview.subscriptionHistory.recent
                    .map(
                      (record) =>
                        `${formatSeasonLabel(record.seasonYear)} ${record.status}`,
                    )
                    .join(", ")}
                </div>
              )}
            </div>

            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Existing future bookings are not automatically repriced by this
              change.
            </div>

            <div className="space-y-2">
              <Label htmlFor="seasonal-membership-reason">Admin reason</Label>
              <Textarea
                id="seasonal-membership-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={1000}
                rows={3}
              />
            </div>

            <ViewOnlyActionButton
              canEdit={canEdit}
              type="button"
              onClick={() => void saveChange()}
              disabled={saving || !reason.trim()}
            >
              {saving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              Save Membership Type
            </ViewOnlyActionButton>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
