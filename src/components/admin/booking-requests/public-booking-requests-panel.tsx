"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";
import { SCHOOL_GROUP_SOFT_CAP } from "@/lib/school-booking-constants";

// Bulk child tiers a school group is counted in. Teachers/parent helpers are
// ADULT and are not adjusted here.
const SCHOOL_CHILD_TIERS = ["INFANT", "CHILD", "YOUTH"] as const;
type SchoolChildTier = (typeof SCHOOL_CHILD_TIERS)[number];
const SCHOOL_CHILD_TIER_LABELS: Record<SchoolChildTier, string> = {
  INFANT: "Infants",
  CHILD: "Children",
  YOUTH: "Youth",
};

/** Count a request's bulk children per tier from its guest snapshot. */
function deriveChildCounts(
  guests: Array<{ ageTier: string }>,
): Record<SchoolChildTier, string> {
  const counts: Record<SchoolChildTier, number> = { INFANT: 0, CHILD: 0, YOUTH: 0 };
  for (const guest of guests) {
    if ((SCHOOL_CHILD_TIERS as readonly string[]).includes(guest.ageTier)) {
      counts[guest.ageTier as SchoolChildTier] += 1;
    }
  }
  return {
    INFANT: String(counts.INFANT),
    CHILD: String(counts.CHILD),
    YOUTH: String(counts.YOUTH),
  };
}

function parseCount(value: string): number {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

type PublicRequestFilter =
  | "QUEUE"
  | "NEW"
  | "VERIFIED"
  | "PRICED"
  | "QUOTED"
  | "QUOTE_SENT"
  | "QUERY_PENDING"
  | "MODIFICATION_REQUESTED"
  | "ACCEPTED"
  | "APPROVED"
  | "DECLINED"
  | "CANCELLED"
  | "CONVERTED"
  | "ALL";

const publicRequestFilters = new Set<PublicRequestFilter>([
  "QUEUE",
  "NEW",
  "VERIFIED",
  "PRICED",
  "QUOTED",
  "QUOTE_SENT",
  "QUERY_PENDING",
  "MODIFICATION_REQUESTED",
  "ACCEPTED",
  "APPROVED",
  "DECLINED",
  "CANCELLED",
  "CONVERTED",
  "ALL",
]);

function isPublicRequestFilter(value: string | null): value is PublicRequestFilter {
  return publicRequestFilters.has(value as PublicRequestFilter);
}

interface PublicBookingRequestData {
  id: string;
  type: string;
  status:
    | "NEW"
    | "VERIFIED"
    | "PRICED"
    | "QUOTED"
    | "QUOTE_SENT"
    | "QUERY_PENDING"
    | "MODIFICATION_REQUESTED"
    | "ACCEPTED"
    | "APPROVED"
    | "DECLINED"
    | "CANCELLED"
    | "CONVERTED";
  schoolName: string | null;
  cateringPreference: "CATERED" | "NON_CATERED" | "QUOTE_BOTH" | null;
  teachers: Array<{ firstName: string; lastName: string; email: string | null }>;
  linkedGuestMembers: Array<{ guestIndex: number; memberId: string }>;
  contactFirstName: string;
  contactLastName: string;
  contactEmail: string;
  contactPhone: string | null;
  checkIn: string;
  checkOut: string;
  guests: Array<{ firstName: string; lastName: string; ageTier: string }>;
  message: string | null;
  indicativePriceCents: number | null;
  priceCents: number | null;
  verifiedAt: string | null;
  pricedAt: string | null;
  pricedByMemberId: string | null;
  pricedByMemberName: string | null;
  reviewedAt: string | null;
  reviewedByMemberId: string | null;
  reviewedByMemberName: string | null;
  declineReason: string | null;
  convertedBookingId: string | null;
  convertedMemberId: string | null;
  heldBookingId: string | null;
  acceptedQuoteOptionId: string | null;
  acceptedPriceCents: number | null;
  acceptedAt: string | null;
  responseMessage: string | null;
  responseMessageAt: string | null;
  latestQuote: {
    id: string;
    version: number;
    status: "DRAFT" | "SENT" | "ACCEPTED" | "CANCELLED" | "SUPERSEDED";
    pricingMode: "OVERALL_TOTAL" | "PER_GUEST_NIGHT";
    sentAt: string | null;
    responseTokenExpiresAt: string | null;
    options: Array<{
      id: string;
      label: string;
      totalCents: number;
      cateringOption: "CATERED" | "NON_CATERED" | null;
    }>;
  } | null;
  createdAt: string;
}

interface MemberSearchResult {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface UiMemberLink {
  guestIndex: number;
  memberId: string;
  label?: string;
}

function formatDate(value: string) {
  return formatNZDate(new Date(value));
}

function formatDateTime(value: string | null) {
  if (!value) return null;
  return formatNZDateTime(new Date(value));
}

function statusBadgeClass(status: PublicBookingRequestData["status"]) {
  if (status === "NEW") return "border-slate-200 bg-slate-100 text-slate-700";
  if (
    status === "VERIFIED" ||
    status === "PRICED" ||
    status === "QUOTED" ||
    status === "QUOTE_SENT" ||
    status === "QUERY_PENDING" ||
    status === "MODIFICATION_REQUESTED"
  ) return "border-amber-200 bg-amber-50 text-amber-800";
  if (status === "APPROVED" || status === "CONVERTED") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

interface PublicBookingRequestsPanelProps {
  basePath?: string;
  fixedSearchParams?: Record<string, string>;
  showHeading?: boolean;
}

const EMPTY_SEARCH_PARAMS: Record<string, string> = {};

const FILTER_LABELS: Record<PublicRequestFilter, string> = {
  QUEUE: "Queue",
  NEW: "Awaiting verification",
  VERIFIED: "Verified",
  PRICED: "Priced",
  QUOTED: "Quoted",
  QUOTE_SENT: "Quote sent",
  QUERY_PENDING: "Query",
  MODIFICATION_REQUESTED: "Modify",
  ACCEPTED: "Accepted",
  APPROVED: "Approved",
  DECLINED: "Declined",
  CANCELLED: "Cancelled",
  CONVERTED: "Converted",
  ALL: "All",
};

function buildPublicRequestsPath(
  basePath: string,
  fixedSearchParams: Record<string, string>,
  status: PublicRequestFilter,
  requestId: string | null,
) {
  const params = new URLSearchParams(fixedSearchParams);

  if (requestId) {
    params.set("requestId", requestId);
  }

  if (status !== "QUEUE") {
    params.set("status", status);
  }

  const query = params.toString();
  return query ? `${basePath}?${query}` : basePath;
}

export function PublicBookingRequestsPanel({
  basePath = "/admin/booking-requests",
  fixedSearchParams = EMPTY_SEARCH_PARAMS,
  showHeading = true,
}: PublicBookingRequestsPanelProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialFilter = searchParams.get("status");
  const requestId = searchParams.get("requestId");
  const [requests, setRequests] = useState<PublicBookingRequestData[]>([]);
  const [filter, setFilter] = useState<PublicRequestFilter>(
    isPublicRequestFilter(initialFilter) ? initialFilter : "QUEUE"
  );
  const [loading, setLoading] = useState(true);
  const [actioningId, setActioningId] = useState<string | null>(null);
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({});
  const [pricingModes, setPricingModes] = useState<
    Record<string, "OVERALL_TOTAL" | "PER_GUEST_NIGHT">
  >({});
  const [rateInputs, setRateInputs] = useState<Record<string, string>>({});
  const [memberLinks, setMemberLinks] = useState<Record<string, UiMemberLink[]>>({});
  const [memberQueries, setMemberQueries] = useState<Record<string, string>>({});
  const [memberResults, setMemberResults] = useState<
    Record<string, MemberSearchResult[]>
  >({});
  const [countInputs, setCountInputs] = useState<
    Record<string, Record<SchoolChildTier, string>>
  >({});
  const [declineReasons, setDeclineReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const currentPath = buildPublicRequestsPath(basePath, fixedSearchParams, filter, requestId);

  useEffect(() => {
    router.replace(currentPath, { scroll: false });
  }, [currentPath, router]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-requests?status=${filter}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to load booking requests");
      }
      setRequests(Array.isArray(data?.data) ? data.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load booking requests");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  function priceInputValue(request: PublicBookingRequestData) {
    if (request.id in priceInputs) return priceInputs[request.id];
    const cents = request.priceCents ?? request.indicativePriceCents;
    return cents != null ? (cents / 100).toFixed(2) : "";
  }

  function quoteOptionIds(request: PublicBookingRequestData) {
    if (request.type !== "SCHOOL") return ["STANDARD"];
    if (request.cateringPreference === "CATERED") return ["CATERED"];
    if (request.cateringPreference === "NON_CATERED") return ["NON_CATERED"];
    return ["CATERED", "NON_CATERED"];
  }

  function optionLabel(optionId: string) {
    if (optionId === "CATERED") return "Catered";
    if (optionId === "NON_CATERED") return "Non-catered";
    return "Quote";
  }

  function priceInputKey(requestId: string, optionId: string) {
    return `${requestId}:${optionId}`;
  }

  function rateInputKey(
    requestId: string,
    optionId: string,
    ageTier: string,
    isMember: boolean
  ) {
    return `${requestId}:${optionId}:${ageTier}:${isMember ? "member" : "non-member"}`;
  }

  function activeMemberLinks(request: PublicBookingRequestData): UiMemberLink[] {
    return memberLinks[request.id] ?? request.linkedGuestMembers;
  }

  function linkedMemberIdFor(request: PublicBookingRequestData, guestIndex: number) {
    return activeMemberLinks(request).find((link) => link.guestIndex === guestIndex)?.memberId;
  }

  function pricingCombos(request: PublicBookingRequestData) {
    const seen = new Set<string>();
    const combos: Array<{ ageTier: string; isMember: boolean }> = [];
    request.guests.forEach((guest, guestIndex) => {
      const isMember = Boolean(linkedMemberIdFor(request, guestIndex));
      const key = `${guest.ageTier}:${isMember}`;
      if (!seen.has(key)) {
        seen.add(key);
        combos.push({ ageTier: guest.ageTier, isMember });
      }
    });
    return combos;
  }

  function optionTotalInputValue(request: PublicBookingRequestData, optionId: string) {
    const key = priceInputKey(request.id, optionId);
    if (key in priceInputs) return priceInputs[key];
    if (request.latestQuote) {
      const option = request.latestQuote.options.find((item) => item.id === optionId);
      if (option) return (option.totalCents / 100).toFixed(2);
    }
    if (optionId === "STANDARD") return priceInputValue(request);
    return "";
  }

  function childCountValues(
    request: PublicBookingRequestData,
  ): Record<SchoolChildTier, string> {
    return countInputs[request.id] ?? deriveChildCounts(request.guests);
  }

  // Teachers/parent helpers (ADULT) plus the current (possibly edited) children.
  function plannedGuestTotal(request: PublicBookingRequestData) {
    const counts = childCountValues(request);
    const children = SCHOOL_CHILD_TIERS.reduce(
      (sum, tier) => sum + parseCount(counts[tier]),
      0,
    );
    return request.teachers.length + children;
  }

  function dollarsToCents(raw: string) {
    const dollars = Number.parseFloat(raw);
    if (!Number.isFinite(dollars) || dollars < 0) return null;
    return Math.round(dollars * 100);
  }

  async function handleCreateQuote(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    try {
      const pricingMode = pricingModes[request.id] ?? "OVERALL_TOTAL";
      const optionIds = quoteOptionIds(request);
      const options = optionIds.map((optionId) => {
        if (pricingMode === "OVERALL_TOTAL") {
          const totalCents = dollarsToCents(optionTotalInputValue(request, optionId));
          if (totalCents == null) {
            throw new Error(`Enter a valid ${optionLabel(optionId).toLowerCase()} total`);
          }
          return {
            id: optionId,
            cateringOption: optionId === "STANDARD" ? null : optionId,
            totalCents,
          };
        }

        const guestNightRates = pricingCombos(request).map((combo) => {
          const key = rateInputKey(request.id, optionId, combo.ageTier, combo.isMember);
          const rateCents = dollarsToCents(rateInputs[key] ?? "");
          if (rateCents == null) {
            throw new Error(
              `Enter a valid ${optionLabel(optionId).toLowerCase()} ${combo.ageTier} ${combo.isMember ? "member" : "non-member"} rate`
            );
          }
          return { ...combo, rateCents };
        });
        return {
          id: optionId,
          cateringOption: optionId === "STANDARD" ? null : optionId,
          guestNightRates,
        };
      });

      const response = await fetch(`/api/admin/booking-requests/${request.id}/quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pricingMode,
          options,
          linkedGuestMembers: activeMemberLinks(request).map(({ guestIndex, memberId }) => ({
            guestIndex,
            memberId,
          })),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to create quote");
      }
      toast.success("Quote saved");
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create quote");
    } finally {
      setActioningId(null);
    }
  }

  async function handleSendQuote(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-requests/${request.id}/send-quote`, {
        method: "POST",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to send quote");
      }
      if (data.emailDelivered === false) {
        setError(
          "The quote was saved and its link is active, but the email could not be delivered — the requester has not received it. Check the contact email address, then send again or reach them another way.",
        );
      } else {
        toast.success("Quote sent");
      }
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send quote");
    } finally {
      setActioningId(null);
    }
  }

  async function handleHoldSlots(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    try {
      const response = await fetch(`/api/admin/booking-requests/${request.id}/hold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          optionId: request.latestQuote?.options[0]?.id,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(data.fullNights)) {
          throw new Error(
            `The lodge is at capacity for: ${data.fullNights
              .map((d: string) => formatDate(d))
              .join(", ")}`
          );
        }
        throw new Error(data.error || "Failed to hold slots");
      }
      toast.success(data.reused ? "Slots were already held" : "Slots held");
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hold slots");
    } finally {
      setActioningId(null);
    }
  }

  async function handleMemberSearch(requestId: string, guestIndex: number) {
    const key = `${requestId}:${guestIndex}`;
    const query = memberQueries[key]?.trim();
    if (!query) return;
    setError("");
    try {
      const response = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&active=true&pageSize=5`
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to search members");
      }
      setMemberResults((prev) => ({
        ...prev,
        [key]: Array.isArray(data.members) ? data.members : [],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to search members");
    }
  }

  function handleLinkMember(
    request: PublicBookingRequestData,
    guestIndex: number,
    member: MemberSearchResult
  ) {
    const label = `${member.firstName} ${member.lastName}`.trim() || member.email;
    const nextLinks = activeMemberLinks(request).filter(
      (link) => link.guestIndex !== guestIndex
    );
    nextLinks.push({ guestIndex, memberId: member.id, label });
    setMemberLinks((prev) => ({ ...prev, [request.id]: nextLinks }));
    setMemberResults((prev) => ({ ...prev, [`${request.id}:${guestIndex}`]: [] }));
  }

  function handleUnlinkMember(request: PublicBookingRequestData, guestIndex: number) {
    setMemberLinks((prev) => ({
      ...prev,
      [request.id]: activeMemberLinks(request).filter(
        (link) => link.guestIndex !== guestIndex
      ),
    }));
  }

  async function handleApprove(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    try {
      // Only send a quantity override when the admin actually edited the school
      // group's child counts; otherwise approve with the submitted numbers.
      const hasCountOverride = request.type === "SCHOOL" && request.id in countInputs;
      const counts = childCountValues(request);
      const response = await fetch(`/api/admin/booking-requests/${request.id}/approve`, {
        method: "POST",
        ...(hasCountOverride
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                childCounts: {
                  INFANT: parseCount(counts.INFANT),
                  CHILD: parseCount(counts.CHILD),
                  YOUTH: parseCount(counts.YOUTH),
                },
              }),
            }
          : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && Array.isArray(data.fullNights)) {
          throw new Error(
            `The lodge is at capacity for: ${data.fullNights
              .map((d: string) => formatDate(d))
              .join(", ")}`
          );
        }
        throw new Error(data.error || "Failed to approve request");
      }
      if (data.type === "SCHOOL") {
        toast.success(
          data.invoiceMode === "xero"
            ? "School booking confirmed. The Xero invoice has been emailed to the school and the teacher PIN email sent."
            : "School booking confirmed. The Xero module is off, so admins have been emailed to invoice the school manually."
        );
      } else {
        toast.success("Request approved. A payment link has been emailed to the requester.");
      }
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve request");
    } finally {
      setActioningId(null);
    }
  }

  async function handleDecline(request: PublicBookingRequestData) {
    setActioningId(request.id);
    setError("");
    try {
      const reason = declineReasons[request.id]?.trim();
      const response = await fetch(`/api/admin/booking-requests/${request.id}/decline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to decline request");
      }
      toast.success("Request declined");
      await fetchRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to decline request");
    } finally {
      setActioningId(null);
    }
  }

  return (
    <div className="space-y-6">
      {showHeading ? (
        <div>
          <h1 className="text-3xl font-bold">Public booking requests</h1>
          <p className="mt-1 text-muted-foreground">
            Review, price and approve booking requests submitted by non-members from the website.
          </p>
        </div>
      ) : null}

      {error && (
        <div className="rounded-md bg-destructive/10 px-4 py-3 text-destructive">
          {error}
          <button onClick={() => setError("")} className="ml-2 underline">
            Dismiss
          </button>
        </div>
      )}


      <div className="flex flex-wrap gap-2">
        {(Object.keys(FILTER_LABELS) as PublicRequestFilter[]).map((status) => (
          <Button
            key={status}
            variant={filter === status ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(status)}
          >
            {FILTER_LABELS[status]}
          </Button>
        ))}
      </div>

      {loading ? (
        <div className="py-8 text-center">Loading...</div>
      ) : requests.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No booking requests found for this filter.
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((request) => {
            const isActioning = actioningId === request.id;

            return (
              <Card
                key={request.id}
                className={request.id === requestId ? "border-amber-300" : undefined}
              >
                <CardHeader>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <CardTitle className="text-lg">
                        {request.type === "SCHOOL" && request.schoolName
                          ? request.schoolName
                          : `${request.contactFirstName} ${request.contactLastName}`}
                      </CardTitle>
                      {request.type === "SCHOOL" ? (
                        <p className="text-sm text-muted-foreground">
                          Contact: {request.contactFirstName} {request.contactLastName}
                        </p>
                      ) : null}
                      <p className="text-sm text-muted-foreground">
                        {request.contactEmail}
                        {request.contactPhone ? ` · ${request.contactPhone}` : ""}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Submitted {formatDateTime(request.createdAt)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {request.type === "SCHOOL" ? (
                        <Badge
                          variant="outline"
                          className="border-indigo-200 bg-indigo-50 text-indigo-800"
                        >
                          School
                        </Badge>
                      ) : null}
                      <Badge variant="outline" className={statusBadgeClass(request.status)}>
                        {request.status}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <span className="text-muted-foreground">Dates:</span>{" "}
                      {formatDate(request.checkIn)} to {formatDate(request.checkOut)}
                    </div>
                    <div>
                      <span className="text-muted-foreground">Guests:</span> {request.guests.length}
                    </div>
                    {request.indicativePriceCents != null ? (
                      <div>
                        <span className="text-muted-foreground">Indicative price:</span>{" "}
                        {formatCents(request.indicativePriceCents)}
                      </div>
                    ) : null}
                    {request.priceCents != null ? (
                      <div>
                        <span className="text-muted-foreground">Quoted price:</span>{" "}
                        {formatCents(request.priceCents)}
                      </div>
                    ) : null}
                  </div>

                  {request.type === "SCHOOL" && request.teachers.length > 0 ? (
                    <div className="text-sm">
                      <span className="text-muted-foreground">Teachers &amp; parent helpers (hut leaders):</span>{" "}
                      {request.teachers
                        .map((teacher) => `${teacher.firstName} ${teacher.lastName}`)
                        .join(", ")}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-1 text-sm">
                    {request.guests.map((guest, index) => (
                      <Badge key={index} variant="secondary">
                        {guest.firstName} {guest.lastName} — {guest.ageTier}
                      </Badge>
                    ))}
                  </div>

                  {request.message ? (
                    <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
                      {request.message}
                    </div>
                  ) : null}

                  {request.status === "NEW" ? (
                    <p className="text-sm text-amber-700">
                      Waiting for the requester to verify their email address.
                    </p>
                  ) : null}

                  {request.latestQuote ? (
                    <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
                      <p className="font-medium">
                        Quote v{request.latestQuote.version} · {request.latestQuote.status}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {request.latestQuote.options.map((option) => (
                          <Badge key={option.id} variant="secondary">
                            {option.label}: {formatCents(option.totalCents)}
                          </Badge>
                        ))}
                      </div>
                      {request.latestQuote.responseTokenExpiresAt ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Link expires {formatDateTime(request.latestQuote.responseTokenExpiresAt)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {request.responseMessage ? (
                    <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p className="font-medium">
                        {request.status === "QUERY_PENDING"
                          ? "Requester question"
                          : request.status === "MODIFICATION_REQUESTED"
                            ? "Requester change request"
                            : "Requester response"}
                      </p>
                      <p className="mt-1">{request.responseMessage}</p>
                      {request.responseMessageAt ? (
                        <p className="mt-1 text-xs opacity-80">
                          Sent {formatDateTime(request.responseMessageAt)}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {[
                    "VERIFIED",
                    "PRICED",
                    "QUOTED",
                    "QUOTE_SENT",
                    "QUERY_PENDING",
                    "MODIFICATION_REQUESTED",
                  ].includes(request.status) ? (
                    <div className="space-y-3 rounded-md border border-slate-200 p-3">
                      {request.type === "SCHOOL" ? (
                        <div className="space-y-2">
                          <Label>Adjust group numbers</Label>
                          <div className="flex flex-wrap items-end gap-3">
                            {SCHOOL_CHILD_TIERS.map((tier) => (
                              <div key={tier} className="space-y-1">
                                <Label
                                  htmlFor={`count-${tier}-${request.id}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  {SCHOOL_CHILD_TIER_LABELS[tier]}
                                </Label>
                                <Input
                                  id={`count-${tier}-${request.id}`}
                                  type="number"
                                  min="0"
                                  className="w-24"
                                  value={childCountValues(request)[tier]}
                                  onChange={(event) =>
                                    setCountInputs((prev) => {
                                      const current =
                                        prev[request.id] ?? deriveChildCounts(request.guests);
                                      return {
                                        ...prev,
                                        [request.id]: { ...current, [tier]: event.target.value },
                                      };
                                    })
                                  }
                                />
                              </div>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {request.teachers.length} teachers &amp; helpers + children ={" "}
                            {plannedGuestTotal(request)} total. Teachers &amp; parent helpers
                            can&apos;t be changed here. Decline and ask the school to resubmit if
                            those change.
                          </p>
                          {plannedGuestTotal(request) > SCHOOL_GROUP_SOFT_CAP ? (
                            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                              Over {SCHOOL_GROUP_SOFT_CAP}: confirm a club member is staying with the
                              group before approving.
                            </p>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="grid gap-3 md:grid-cols-[220px_1fr]">
                        <div className="space-y-1">
                          <Label htmlFor={`pricing-mode-${request.id}`}>Pricing mode</Label>
                          <Select
                            value={pricingModes[request.id] ?? "OVERALL_TOTAL"}
                            onValueChange={(value) =>
                              setPricingModes((prev) => ({
                                ...prev,
                                [request.id]: value as "OVERALL_TOTAL" | "PER_GUEST_NIGHT",
                              }))
                            }
                          >
                            <SelectTrigger id={`pricing-mode-${request.id}`}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="OVERALL_TOTAL">Overall total</SelectItem>
                              <SelectItem value="PER_GUEST_NIGHT">Per guest-night</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-2">
                          {quoteOptionIds(request).map((optionId) => (
                            <div key={optionId} className="rounded-md border bg-white p-3">
                              <p className="text-sm font-medium">{optionLabel(optionId)}</p>
                              {(pricingModes[request.id] ?? "OVERALL_TOTAL") === "OVERALL_TOTAL" ? (
                                <div className="mt-2 flex flex-wrap items-end gap-3">
                                  <div className="space-y-1">
                                    <Label htmlFor={`price-${request.id}-${optionId}`}>
                                      Total (NZD)
                                    </Label>
                                    <Input
                                      id={`price-${request.id}-${optionId}`}
                                      type="number"
                                      min="0"
                                      step="0.01"
                                      className="w-32"
                                      value={optionTotalInputValue(request, optionId)}
                                      onChange={(event) =>
                                        setPriceInputs((prev) => ({
                                          ...prev,
                                          [priceInputKey(request.id, optionId)]:
                                            event.target.value,
                                        }))
                                      }
                                    />
                                  </div>
                                </div>
                              ) : (
                                <div className="mt-2 flex flex-wrap gap-3">
                                  {pricingCombos(request).map((combo) => {
                                    const key = rateInputKey(
                                      request.id,
                                      optionId,
                                      combo.ageTier,
                                      combo.isMember
                                    );
                                    return (
                                      <div key={key} className="space-y-1">
                                        <Label htmlFor={key}>
                                          {combo.ageTier}{" "}
                                          {combo.isMember ? "member" : "non-member"}
                                        </Label>
                                        <Input
                                          id={key}
                                          type="number"
                                          min="0"
                                          step="0.01"
                                          className="w-32"
                                          value={rateInputs[key] ?? ""}
                                          onChange={(event) =>
                                            setRateInputs((prev) => ({
                                              ...prev,
                                              [key]: event.target.value,
                                            }))
                                          }
                                        />
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <p className="text-sm font-medium">Linked member guests</p>
                        <div className="grid gap-2">
                          {request.guests.map((guest, guestIndex) => {
                            const key = `${request.id}:${guestIndex}`;
                            const linkedId = linkedMemberIdFor(request, guestIndex);
                            const linkedLabel = activeMemberLinks(request).find(
                              (link) => link.guestIndex === guestIndex
                            )?.label;
                            return (
                              <div
                                key={key}
                                className="grid gap-2 rounded-md border bg-white p-2 md:grid-cols-[1fr_220px_auto]"
                              >
                                <div className="text-sm">
                                  <p className="font-medium">
                                    {guest.firstName} {guest.lastName}
                                  </p>
                                  <p className="text-xs text-muted-foreground">{guest.ageTier}</p>
                                  {linkedId ? (
                                    <p className="mt-1 text-xs text-emerald-700">
                                      Linked to {linkedLabel ?? linkedId}
                                    </p>
                                  ) : null}
                                </div>
                                <Input
                                  value={memberQueries[key] ?? ""}
                                  onChange={(event) =>
                                    setMemberQueries((prev) => ({
                                      ...prev,
                                      [key]: event.target.value,
                                    }))
                                  }
                                  placeholder="Search member"
                                />
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleMemberSearch(request.id, guestIndex)}
                                  >
                                    Search
                                  </Button>
                                  {linkedId ? (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => handleUnlinkMember(request, guestIndex)}
                                    >
                                      Unlink
                                    </Button>
                                  ) : null}
                                </div>
                                {memberResults[key]?.length ? (
                                  <div className="md:col-span-3 flex flex-wrap gap-2">
                                    {memberResults[key].map((member) => (
                                      <Button
                                        key={member.id}
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        onClick={() =>
                                          handleLinkMember(request, guestIndex, member)
                                        }
                                      >
                                        {member.firstName} {member.lastName}
                                      </Button>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>

                      <div className="space-y-1">
                        <Label htmlFor={`decline-reason-${request.id}`}>Decline reason (optional)</Label>
                        <Textarea
                          id={`decline-reason-${request.id}`}
                          value={declineReasons[request.id] ?? ""}
                          onChange={(event) =>
                            setDeclineReasons((prev) => ({ ...prev, [request.id]: event.target.value }))
                          }
                          maxLength={2000}
                          placeholder="Shown to the requester in the decline email"
                        />
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCreateQuote(request)}
                          disabled={isActioning}
                        >
                          Save quote
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleSendQuote(request)}
                          disabled={isActioning || !request.latestQuote}
                        >
                          Send quote
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleHoldSlots(request)}
                          disabled={isActioning || Boolean(request.heldBookingId)}
                        >
                          {request.heldBookingId ? "Slots held" : "Hold slots"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleApprove(request)}
                          disabled={
                            isActioning ||
                            (request.type !== "SCHOOL" && request.status !== "PRICED")
                          }
                        >
                          {request.type === "SCHOOL"
                            ? "Approve & invoice school"
                            : "Approve & send payment link"}
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => handleDecline(request)}
                          disabled={isActioning}
                        >
                          Decline
                        </Button>
                      </div>
                      {request.status === "VERIFIED" ? (
                        <p className="text-xs text-muted-foreground">
                          {request.type === "SCHOOL"
                            ? "Adjust group numbers if needed, then save and send a quote so the school can accept or request changes."
                            : "Save and send a quote so the requester can accept, cancel, query, or request changes."}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  {request.status === "DECLINED" ? (
                    <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                      Declined
                      {formatDateTime(request.reviewedAt) ? ` on ${formatDateTime(request.reviewedAt)}` : ""}
                      {request.reviewedByMemberName ? ` by ${request.reviewedByMemberName}` : ""}
                      {request.declineReason ? <p className="mt-2">{request.declineReason}</p> : null}
                    </div>
                  ) : null}

                  {(request.status === "APPROVED" || request.status === "CONVERTED") ? (
                    <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
                      Approved
                      {formatDateTime(request.reviewedAt) ? ` on ${formatDateTime(request.reviewedAt)}` : ""}
                      {request.reviewedByMemberName ? ` by ${request.reviewedByMemberName}` : ""}
                      {request.pricedByMemberName ? ` · Priced by ${request.pricedByMemberName}` : ""}
                      {request.convertedBookingId ? (
                        <p className="mt-2">
                          <Link
                            href={buildHrefWithReturnTo(
                              `/bookings/${request.convertedBookingId}`,
                              currentPath
                            )}
                            className="text-blue-600 hover:underline"
                          >
                            Open booking
                          </Link>
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
