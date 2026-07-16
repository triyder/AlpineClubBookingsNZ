"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface DeletionRequestMember {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  active: boolean;
}

interface DeletionRequest {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reason: string | null;
  adminNote: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  member: DeletionRequestMember;
}

interface ApiResponse {
  requests: DeletionRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Admin-initiated hard-delete review requests (MemberLifecycleActionRequest,
// action DELETE). Distinct from the self-service DeletionRequest above.
interface LifecycleRequest {
  id: string;
  status: "REQUESTED" | "APPROVED" | "REJECTED";
  reason: string;
  reviewNote: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  requestedByMemberId: string | null;
  requestedBy: { id: string; name: string; email: string } | null;
  targetName: string;
  member: { id: string; name: string; email: string } | null;
}

interface LifecycleApiResponse {
  requests: LifecycleRequest[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

const dateTime = (value: string) =>
  new Date(value).toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function DeletionRequestsClient({
  sessionMemberId,
}: {
  sessionMemberId: string;
}) {
  const [statusFilter, setStatusFilter] = useState("PENDING");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [reviewDialog, setReviewDialog] = useState<{
    request: DeletionRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: statusFilter,
        page: String(page),
      });
      const res = await fetch(`/api/admin/deletion-requests?${params}`);
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch {
      setError("Failed to load deletion requests.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // #1788: `notifyMember` is only meaningful on the reject path (the approve
  // path always sends the final privacy receipt). Absent = notify (default),
  // false = suppress the member email.
  async function handleReview(notifyMember?: boolean) {
    if (!reviewDialog) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/deletion-requests/${reviewDialog.request.id}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: reviewDialog.action,
            note: reviewNote || undefined,
            ...(notifyMember === undefined ? {} : { notifyMember }),
          }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed");
      setReviewDialog(null);
      setReviewNote("");
      fetchRequests();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to process request");
    } finally {
      setSubmitting(false);
    }
  }

  const statusBadge = (status: string) => {
    if (status === "PENDING")
      return (
        <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">
          Pending
        </Badge>
      );
    if (status === "APPROVED")
      return (
        <Badge className="bg-green-100 text-green-800 border-green-200">
          Approved
        </Badge>
      );
    return (
      <Badge className="bg-red-100 text-red-800 border-red-200">Rejected</Badge>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Deletion Requests</h1>
        <p className="mt-1 text-sm text-slate-500">
          Review member account deletion requests. Members can request deletion
          of their own account; admins can request permanent (hard) deletion of
          a member record added in error. Hard-delete requests require a second
          admin to approve.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Member self-service requests</CardTitle>
              <CardDescription>
                {data ? `${data.total} total` : "Loading..."}
              </CardDescription>
            </div>
            <Select
              value={statusFilter}
              onValueChange={(v) => {
                setStatusFilter(v);
                setPage(1);
              }}
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PENDING">Pending</SelectItem>
                <SelectItem value="APPROVED">Approved</SelectItem>
                <SelectItem value="REJECTED">Rejected</SelectItem>
                <SelectItem value="ALL">All</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading && (
            <p className="text-sm text-slate-500 py-4">Loading...</p>
          )}
          {error && (
            <p className="text-sm text-red-600 py-4">{error}</p>
          )}
          {!loading && data && data.requests.length === 0 && (
            <p className="text-sm text-slate-500 py-4">
              No {statusFilter === "ALL" ? "" : statusFilter.toLowerCase()}{" "}
              deletion requests.
            </p>
          )}
          {!loading && data && data.requests.length > 0 && (
            <div className="divide-y">
              {data.requests.map((req) => (
                <div key={req.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900">
                          {req.member.firstName} {req.member.lastName}
                        </span>
                        <span className="text-sm text-slate-500">
                          {req.member.email}
                        </span>
                        {statusBadge(req.status)}
                      </div>
                      <p className="text-xs text-slate-400">
                        Requested {dateTime(req.createdAt)}
                      </p>
                      {req.reason && (
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Reason:</span>{" "}
                          {req.reason}
                        </p>
                      )}
                      {req.adminNote && (
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Admin note:</span>{" "}
                          {req.adminNote}
                        </p>
                      )}
                      {req.reviewedAt && (
                        <p className="text-xs text-slate-400">
                          Reviewed{" "}
                          {new Date(req.reviewedAt).toLocaleDateString("en-NZ", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </p>
                      )}
                    </div>
                    {req.status === "PENDING" && (
                      <div className="flex gap-2 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-red-600 border-red-200 hover:bg-red-50"
                          onClick={() =>
                            setReviewDialog({ request: req, action: "reject" })
                          }
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            setReviewDialog({ request: req, action: "approve" })
                          }
                        >
                          Approve
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pagination */}
          {data && data.totalPages > 1 && (
            <div className="flex items-center justify-between pt-4 border-t">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-slate-500">
                Page {page} of {data.totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= data.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <AdminInitiatedDeletionSection
        sessionMemberId={sessionMemberId}
        statusFilter={statusFilter}
        statusBadge={statusBadge}
      />

      {/* Review Dialog (self-service) */}
      <Dialog
        open={!!reviewDialog}
        onOpenChange={(open) => {
          if (!open) {
            setReviewDialog(null);
            setReviewNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewDialog?.action === "approve"
                ? "Approve Deletion Request"
                : "Reject Deletion Request"}
            </DialogTitle>
            <DialogDescription>
              {reviewDialog?.action === "approve" ? (
                <>
                  This will permanently anonymise{" "}
                  <strong>
                    {reviewDialog.request.member.firstName}{" "}
                    {reviewDialog.request.member.lastName}
                  </strong>
                  &apos;s account, cancel all future bookings, and deactivate
                  their login. This action cannot be undone.
                </>
              ) : reviewDialog?.request.member.email ? (
                <>
                  Choose below whether to email the member that their request
                  was not approved — either way the request is rejected.
                </>
              ) : (
                <>
                  The request will be rejected. This member has no email address
                  on file, so no notification is sent.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="review-note">
              {reviewDialog?.action === "approve"
                ? "Note (optional)"
                : "Reason for rejection (optional — will be sent to member)"}
            </Label>
            <Textarea
              id="review-note"
              value={reviewNote}
              onChange={(e) => setReviewNote(e.target.value)}
              placeholder={
                reviewDialog?.action === "reject"
                  ? "E.g. Outstanding bookings must be resolved first"
                  : "Internal note"
              }
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setReviewDialog(null);
                setReviewNote("");
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            {reviewDialog?.action === "approve" ? (
              // The approve receipt always sends (the member asked for deletion
              // and cannot log in afterwards), so no notify choice here.
              <Button
                variant="destructive"
                onClick={() => handleReview()}
                disabled={submitting}
              >
                {submitting ? "Processing..." : "Approve & Delete Account"}
              </Button>
            ) : reviewDialog?.request.member.email ? (
              // #1788: reject with a member on file — two-button email choice.
              <>
                <Button
                  variant="outline"
                  onClick={() => handleReview(false)}
                  disabled={submitting}
                >
                  {submitting ? "Processing..." : "Reject without emailing"}
                </Button>
                <Button
                  onClick={() => handleReview(true)}
                  disabled={submitting}
                >
                  {submitting ? "Processing..." : "Reject and email member"}
                </Button>
              </>
            ) : (
              // No address on file — nothing would send, so reject directly.
              <Button onClick={() => handleReview()} disabled={submitting}>
                {submitting ? "Processing..." : "Reject Request"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Admin-initiated hard-delete review queue (#1938). Fetches DELETE lifecycle
// requests via the shared list API, reusing the page's status filter through
// its PENDING->REQUESTED mapping. Approve/reject goes to the EXISTING lifecycle
// review PATCH, which enforces the second-admin rule server-side (403); the
// disabled buttons here are a UX hint, not the authority.
function AdminInitiatedDeletionSection({
  sessionMemberId,
  statusFilter,
  statusBadge,
}: {
  sessionMemberId: string;
  statusFilter: string;
  statusBadge: (status: string) => React.ReactNode;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LifecycleApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{
    request: LifecycleRequest;
    action: "approve" | "reject";
  } | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // The status filter lives in the parent card header; when it changes, jump
  // back to page 1 so a deep page from the previous filter is never shown.
  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        action: "DELETE",
        status: statusFilter,
        page: String(page),
      });
      const res = await fetch(
        `/api/admin/member-lifecycle-action-requests?${params}`
      );
      if (!res.ok) throw new Error("Failed to load");
      setData(await res.json());
    } catch {
      setError("Failed to load admin-initiated deletion requests.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  async function submitReview() {
    if (!dialog) return;
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/member-lifecycle-action-requests/${dialog.request.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: dialog.action,
            note: note || undefined,
          }),
        }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed");
      setDialog(null);
      setNote("");
      fetchRequests();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to process request");
    } finally {
      setSubmitting(false);
    }
  }

  // Lifecycle requests use REQUESTED for the pending state; the shared badge
  // renderer speaks PENDING, so translate before rendering.
  const renderStatus = (status: string) =>
    statusBadge(status === "REQUESTED" ? "PENDING" : status);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin-initiated deletion requests</CardTitle>
        <CardDescription>
          Permanent hard-delete requests raised by an admin from a member
          record. A different admin must approve or reject each request.
          Filtered by the status selector above.
          {data ? ` ${data.total} total` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-slate-500 py-4">Loading...</p>}
        {error && <p className="text-sm text-red-600 py-4">{error}</p>}
        {!loading && data && data.requests.length === 0 && (
          <p className="text-sm text-slate-500 py-4">
            No {statusFilter === "ALL" ? "" : statusFilter.toLowerCase()}{" "}
            admin-initiated deletion requests.
          </p>
        )}
        {!loading && data && data.requests.length > 0 && (
          <div className="divide-y">
            {data.requests.map((req) => {
              const isOwnRequest =
                req.requestedByMemberId === sessionMemberId;
              const requesterLabel =
                req.requestedBy?.name ||
                req.requestedBy?.email ||
                "Unknown admin";
              return (
                <div key={req.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-slate-900">
                          {req.targetName}
                        </span>
                        {req.member?.email && (
                          <span className="text-sm text-slate-500">
                            {req.member.email}
                          </span>
                        )}
                        {renderStatus(req.status)}
                      </div>
                      <p className="text-xs text-slate-400">
                        Requested by {requesterLabel} · {dateTime(req.requestedAt)}
                      </p>
                      {req.reason && (
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Reason:</span>{" "}
                          {req.reason}
                        </p>
                      )}
                      {req.reviewNote && (
                        <p className="text-sm text-slate-600">
                          <span className="font-medium">Review note:</span>{" "}
                          {req.reviewNote}
                        </p>
                      )}
                    </div>
                    {req.status === "REQUESTED" && (
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-600 border-red-200 hover:bg-red-50"
                            disabled={isOwnRequest}
                            title={
                              isOwnRequest
                                ? "A different admin must review this request"
                                : undefined
                            }
                            onClick={() =>
                              setDialog({ request: req, action: "reject" })
                            }
                          >
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={isOwnRequest}
                            title={
                              isOwnRequest
                                ? "A different admin must review this request"
                                : undefined
                            }
                            onClick={() =>
                              setDialog({ request: req, action: "approve" })
                            }
                          >
                            Approve
                          </Button>
                        </div>
                        {isOwnRequest && (
                          <p className="text-xs text-slate-400">
                            A different admin must review this request
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {data && data.totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <span className="text-sm text-slate-500">
              Page {page} of {data.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog
        open={!!dialog}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setNote("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {dialog?.action === "approve"
                ? "Approve hard-delete request"
                : "Reject hard-delete request"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.action === "approve" ? (
                <>
                  This will permanently delete{" "}
                  <strong>{dialog.request.targetName}</strong>&apos;s member
                  record. Eligibility is re-checked at approval; this action
                  cannot be undone.
                </>
              ) : (
                <>
                  Reject the request to hard-delete{" "}
                  <strong>{dialog?.request.targetName}</strong>. The record is
                  left unchanged.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Label htmlFor="lifecycle-review-note">Note (optional)</Label>
            <Textarea
              id="lifecycle-review-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Internal review note"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDialog(null);
                setNote("");
              }}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              variant={dialog?.action === "approve" ? "destructive" : "default"}
              onClick={submitReview}
              disabled={submitting}
            >
              {submitting
                ? "Processing..."
                : dialog?.action === "approve"
                  ? "Approve & Delete Record"
                  : "Reject Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
