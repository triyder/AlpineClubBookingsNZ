"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trash2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AgeTierBadge } from "@/components/admin/family-groups/age-tier-badge";
import { FamilyGroupLoginHolderSection } from "@/components/admin/family-groups/login-holder-section";
import { FamilyGroupRequestReviewCard } from "@/components/admin/family-groups/request-review-card";
import {
  buildInitialRequestNotificationParents,
  buildInitialRequestSelections,
  buildSharedEmailClusters,
  getFamilyGroupRequestSubjectName,
  getMemberName,
  mapFamilyGroupRequestSearchResults,
  normalizeFamilyEmail,
  type FamilyGroupDetail,
  type FamilyGroupMemberRow,
  type FamilyGroupRequest,
  type MemberOption,
  type RequestMemberMatch,
  type SharedEmailCluster,
} from "@/lib/admin-family-group-ui-helpers";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { resolveEffectiveEmail } from "@/lib/member-email";

export interface FamilyGroupEditorProps {
  groupId: string;
  onClose: () => void;
  onChanged?: () => void;
}

export function FamilyGroupEditor({
  groupId,
  onClose,
  onChanged,
}: FamilyGroupEditorProps) {
  const [group, setGroup] = useState<FamilyGroupDetail | null>(null);
  const [requests, setRequests] = useState<FamilyGroupRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [formName, setFormName] = useState("");
  const [selectedMembers, setSelectedMembers] = useState<MemberOption[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [searchResults, setSearchResults] = useState<MemberOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [requestSelections, setRequestSelections] = useState<Record<string, string>>({});
  const [requestSearchTerms, setRequestSearchTerms] = useState<Record<string, string>>({});
  const [requestSearchResults, setRequestSearchResults] = useState<Record<string, RequestMemberMatch[]>>({});
  const [requestSearchFeedback, setRequestSearchFeedback] = useState<Record<string, string>>({});
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});
  const [requestNotificationParents, setRequestNotificationParents] = useState<Record<string, string>>({});
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [requestSearchingId, setRequestSearchingId] = useState<string | null>(null);
  const [requestSubmittingId, setRequestSubmittingId] = useState<string | null>(null);
  const [loginHolderSelections, setLoginHolderSelections] = useState<Record<string, string>>({});
  const [loginHolderSavingEmail, setLoginHolderSavingEmail] = useState<string | null>(null);
  const [loginHolderErrors, setLoginHolderErrors] = useState<Record<string, string>>({});
  const [loginHolderMessages, setLoginHolderMessages] = useState<Record<string, string>>({});
  const [setupInviteSendingId, setSetupInviteSendingId] = useState<string | null>(null);
  const [setupInviteMessages, setSetupInviteMessages] = useState<Record<string, string>>({});
  const editorRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const { scrollToError, scrollToTop } = useScrollToFeedback();

  const sharedEmailClusters = useMemo(
    () => buildSharedEmailClusters(group?.members ?? []),
    [group?.members]
  );

  const refreshEditor = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [groupRes, requestsRes] = await Promise.all([
        fetch(`/api/admin/family-groups/${groupId}`),
        fetch("/api/admin/family-groups/requests"),
      ]);

      const groupData = await groupRes.json().catch(() => ({}));
      if (!groupRes.ok) {
        throw new Error(groupData.error || "Failed to load family group");
      }

      const rawMembers = (groupData.members ?? []) as FamilyGroupMemberRow[];
      const members = await Promise.all(
        rawMembers.map(async (member) => ({
          ...member,
          effectiveEmail: normalizeFamilyEmail(resolveEffectiveEmail(member)),
        }))
      );

      const nextGroup = { ...groupData, members } as FamilyGroupDetail;
      setGroup(nextGroup);
      setFormName(nextGroup.name || "");
      setSelectedMembers(
        members.map((member) => ({
          id: member.id,
          firstName: member.firstName,
          lastName: member.lastName,
          email: member.email,
        }))
      );

      const clusters = buildSharedEmailClusters(members);
      setLoginHolderSelections((current) => {
        const nextSelections: Record<string, string> = {};
        for (const cluster of clusters) {
          nextSelections[cluster.email] =
            current[cluster.email] ||
            cluster.members.find((member) => member.canLogin)?.id ||
            "";
        }
        return nextSelections;
      });

      if (requestsRes.ok) {
        const requestData = await requestsRes.json();
        const groupRequests = ((requestData.requests ?? []) as FamilyGroupRequest[])
          .filter((request) => request.familyGroup.id === groupId);
        setRequests(groupRequests);
        setRequestSelections((current) =>
          buildInitialRequestSelections(groupRequests, current)
        );
        setRequestNotificationParents((current) =>
          buildInitialRequestNotificationParents(groupRequests, current)
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load family group");
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    refreshEditor();
  }, [refreshEditor]);

  useEffect(() => {
    if (error) scrollToError(errorRef);
  }, [error, scrollToError]);

  useEffect(() => {
    if (memberSearch.length < 2) {
      setSearchResults([]);
      return;
    }

    let cancelled = false;
    setSearching(true);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/members?q=${encodeURIComponent(memberSearch)}&type=primary&active=true&pageSize=10`
        );
        if (res.ok && !cancelled) {
          const data = await res.json();
          const selectedIds = new Set(selectedMembers.map((member) => member.id));
          setSearchResults(
            (data.members ?? [])
              .filter((member: MemberOption) => !selectedIds.has(member.id))
              .map((member: MemberOption) => ({
                id: member.id,
                firstName: member.firstName,
                lastName: member.lastName,
                email: member.email,
              }))
          );
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [memberSearch, selectedMembers]);

  function addMember(member: MemberOption) {
    setSelectedMembers((current) => [...current, member]);
    setMemberSearch("");
    setSearchResults([]);
  }

  function removeMember(id: string) {
    setSelectedMembers((current) => current.filter((member) => member.id !== id));
  }

  function clearRequestError(requestId: string) {
    setRequestErrors((current) => {
      if (!current[requestId]) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }

  function clearRequestSearchFeedback(requestId: string) {
    setRequestSearchFeedback((current) => {
      if (!current[requestId]) return current;
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }

  async function searchRequestMembers(request: FamilyGroupRequest) {
    const query =
      requestSearchTerms[request.id]?.trim() ||
      getFamilyGroupRequestSubjectName(request);

    if (query.length < 2) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: "Enter at least 2 characters to search for an existing member record.",
      }));
      return;
    }

    clearRequestError(request.id);
    clearRequestSearchFeedback(request.id);
    setRequestSearchingId(request.id);

    try {
      const ageTierSearchFilter =
        request.type === "CHILD_REQUEST" ? "&ageTierIn=INFANT,CHILD,YOUTH" : "";
      const res = await fetch(
        `/api/admin/members?q=${encodeURIComponent(query)}&active=true&pageSize=10${ageTierSearchFilter}`
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRequestErrors((current) => ({
          ...current,
          [request.id]: data.error || "Failed to search member records.",
        }));
        return;
      }

      const foundMembers = mapFamilyGroupRequestSearchResults(
        request,
        data.members ?? []
      );

      setRequestSearchResults((current) => ({
        ...current,
        [request.id]: foundMembers,
      }));

      if (foundMembers.length === 1) {
        setRequestSelections((current) => ({
          ...current,
          [request.id]: foundMembers[0].id,
        }));
      }

      setRequestSearchFeedback((current) => ({
        ...current,
        [request.id]:
          foundMembers.length === 0
            ? `No eligible member records found for "${query}".`
            : foundMembers.length === 1
              ? `Found and selected ${foundMembers[0].firstName} ${foundMembers[0].lastName}.`
              : `Found ${foundMembers.length} member records.`,
      }));
    } finally {
      setRequestSearchingId((current) => (current === request.id ? null : current));
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setStatusMessage("");

    if (selectedMembers.length < 1) {
      setError("At least one member is required");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/family-groups/${groupId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName.trim(),
          memberIds: selectedMembers.map((member) => member.id),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to save family group");
        return;
      }

      scrollToTop(editorRef);
      onChanged?.();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Delete this family group? Members will be unlinked.")) return;

    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/family-groups/${groupId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Failed to delete family group");
        return;
      }

      onChanged?.();
      onClose();
    } finally {
      setDeleting(false);
    }
  }

  async function handleRequest(request: FamilyGroupRequest, action: "approve" | "reject") {
    clearRequestError(request.id);
    const linkedMemberId = requestSelections[request.id];
    const needsMemberSelection =
      request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";

    if (action === "approve" && needsMemberSelection && !linkedMemberId) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: "Choose the member record to link, or create a new non-login adult where available.",
      }));
      return;
    }

    setRequestSubmittingId(request.id);

    try {
      const res = await fetch("/api/admin/family-groups/requests", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: request.id,
          action,
          ...(action === "approve" && needsMemberSelection && linkedMemberId
            ? linkedMemberId === "__create__"
              ? { createNewMember: true }
              : {
                  linkedMemberId,
                  ...(request.type === "CHILD_REQUEST"
                    ? { inheritEmailFromId: requestNotificationParents[request.id] ?? request.requester.id }
                    : {}),
                }
            : {}),
          ...(action === "reject" && requestNotes[request.id]?.trim()
            ? { rejectionReason: requestNotes[request.id].trim() }
            : {}),
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setRequestErrors((current) => ({
          ...current,
          [request.id]: data.error || `Failed to ${action} request.`,
        }));
        return;
      }

      setRequestSearchResults((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setRequestSearchTerms((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setRequestSearchFeedback((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      setRequestNotes((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });

      await refreshEditor();
      onChanged?.();
    } finally {
      setRequestSubmittingId((current) => (current === request.id ? null : current));
    }
  }

  async function sendPasswordSetupInvite(member: FamilyGroupMemberRow) {
    setSetupInviteSendingId(member.id);
    setSetupInviteMessages((current) => {
      const next = { ...current };
      delete next[member.id];
      return next;
    });

    try {
      const res = await fetch("/api/admin/members/send-setup-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds: [member.id] }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok || data.sent !== 1) {
        setSetupInviteMessages((current) => ({
          ...current,
          [member.id]: data.error || "Password setup email could not be sent.",
        }));
        return;
      }

      setSetupInviteMessages((current) => ({
        ...current,
        [member.id]: "Password setup email sent.",
      }));
    } finally {
      setSetupInviteSendingId((current) => (current === member.id ? null : current));
    }
  }

  async function saveLoginHolder(cluster: SharedEmailCluster) {
    const newHolderId = loginHolderSelections[cluster.email];
    if (!newHolderId) {
      setLoginHolderErrors((current) => ({
        ...current,
        [cluster.email]: "Choose an adult member before saving.",
      }));
      return;
    }

    setLoginHolderSavingEmail(cluster.email);
    setLoginHolderErrors((current) => {
      const next = { ...current };
      delete next[cluster.email];
      return next;
    });
    setLoginHolderMessages((current) => {
      const next = { ...current };
      delete next[cluster.email];
      return next;
    });

    try {
      const res = await fetch(`/api/admin/family-groups/${groupId}/login-holder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cluster.email, newHolderId }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setLoginHolderErrors((current) => ({
          ...current,
          [cluster.email]: data.error || "Failed to save login holder.",
        }));
        return;
      }

      setLoginHolderMessages((current) => ({
        ...current,
        [cluster.email]: "Login holder updated.",
      }));
      await refreshEditor();
      onChanged?.();
    } finally {
      setLoginHolderSavingEmail((current) => (current === cluster.email ? null : current));
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-slate-500">Loading family group...</CardContent>
      </Card>
    );
  }

  if (!group) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <p className="text-sm text-red-600">{error || "Family group not found"}</p>
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card ref={editorRef}>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="text-lg">Edit Family Group</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              Rename the group, manage linked members, review pending requests, or swap a shared-email login holder.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-red-600 hover:bg-red-50 hover:text-red-700"
            onClick={handleDelete}
            disabled={deleting}
          >
            <Trash2 className="h-4 w-4" />
            {deleting ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && (
          <p
            ref={errorRef}
            role="alert"
            tabIndex={-1}
            className="scroll-mt-20 text-sm text-red-600 focus:outline-none"
          >
            {error}
          </p>
        )}
        {statusMessage && <p className="text-sm text-emerald-700">{statusMessage}</p>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor={`family-group-name-${groupId}`}>Group Name</Label>
            <Input
              id={`family-group-name-${groupId}`}
              value={formName}
              onChange={(event) => setFormName(event.target.value)}
              placeholder='e.g., "Smith Family"'
              required
            />
          </div>

          <div>
            <Label>Members</Label>
            {selectedMembers.length > 0 && (
              <div className="mb-2 mt-2 flex flex-wrap gap-2">
                {selectedMembers.map((member) => {
                  const memberInfo = group.members.find((groupMember) => groupMember.id === member.id);
                  return (
                    <Badge
                      key={member.id}
                      variant="secondary"
                      className="flex items-center gap-1 px-2 py-1"
                    >
                      {getMemberName(member)}
                      {memberInfo?.ageTier && <AgeTierBadge tier={memberInfo.ageTier} />}
                      <button
                        type="button"
                        onClick={() => removeMember(member.id)}
                        className="ml-1 hover:text-red-600"
                        aria-label={`Remove ${getMemberName(member)}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  );
                })}
              </div>
            )}
            <div className="relative">
              <Input
                value={memberSearch}
                onChange={(event) => setMemberSearch(event.target.value)}
                placeholder="Search members by name or email..."
              />
              {searching && (
                <div className="absolute right-3 top-2.5 text-xs text-slate-400">
                  Searching...
                </div>
              )}
              {searchResults.length > 0 && (
                <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border bg-white shadow-lg">
                  {searchResults.map((member) => (
                    <button
                      key={member.id}
                      type="button"
                      onClick={() => addMember(member)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="font-medium">{getMemberName(member)}</span>
                      <span className="ml-2 text-slate-500">{member.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Add adults, youth, or children to this family group
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={submitting || selectedMembers.length < 1}>
              {submitting ? "Saving..." : "Update Group"}
            </Button>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>

        <FamilyGroupLoginHolderSection
          clusters={sharedEmailClusters}
          selections={loginHolderSelections}
          savingEmail={loginHolderSavingEmail}
          errors={loginHolderErrors}
          messages={loginHolderMessages}
          setupInviteSendingId={setupInviteSendingId}
          setupInviteMessages={setupInviteMessages}
          onSelectLoginHolder={(email, memberId) =>
            setLoginHolderSelections((current) => ({
              ...current,
              [email]: memberId,
            }))
          }
          onSaveLoginHolder={saveLoginHolder}
          onSendPasswordSetupInvite={sendPasswordSetupInvite}
        />

        <section className="space-y-3 rounded-lg border border-slate-200 p-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Pending family changes</h3>
            <p className="mt-1 text-sm text-slate-500">
              Review requests that target this family group.
            </p>
          </div>
          {requests.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-200 p-3 text-sm text-slate-500">
              No pending requests for this group.
            </p>
          ) : (
            requests.map((request) => (
              <FamilyGroupRequestReviewCard
                key={request.id}
                idPrefix="editor-"
                request={request}
                requestSelection={requestSelections[request.id]}
                requestSearchTerm={requestSearchTerms[request.id]}
                searchedMembers={requestSearchResults[request.id] ?? []}
                requestSearchMessage={requestSearchFeedback[request.id]}
                requestNote={requestNotes[request.id]}
                requestNotificationParentId={requestNotificationParents[request.id]}
                requestError={requestErrors[request.id]}
                searching={requestSearchingId === request.id}
                submitting={requestSubmittingId === request.id}
                showRemovalDetails
                onClearRequestFeedback={() => {
                  clearRequestError(request.id);
                  clearRequestSearchFeedback(request.id);
                }}
                onSearchMembers={() => searchRequestMembers(request)}
                onSelectMember={(memberId) =>
                  setRequestSelections((current) => ({
                    ...current,
                    [request.id]: memberId,
                  }))
                }
                onSearchTermChange={(value) =>
                  setRequestSearchTerms((current) => ({
                    ...current,
                    [request.id]: value,
                  }))
                }
                onNotificationParentChange={(memberId) =>
                  setRequestNotificationParents((current) => ({
                    ...current,
                    [request.id]: memberId,
                  }))
                }
                onNoteChange={(value) =>
                  setRequestNotes((current) => ({
                    ...current,
                    [request.id]: value,
                  }))
                }
                onApprove={() => handleRequest(request, "approve")}
                onReject={() => handleRequest(request, "reject")}
              />
            ))
          )}
        </section>
      </CardContent>
    </Card>
  );
}
