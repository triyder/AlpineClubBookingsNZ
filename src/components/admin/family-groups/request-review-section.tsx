"use client";

import { useEffect, useState } from "react";
import { FamilyGroupRequestReviewCard } from "@/components/admin/family-groups/request-review-card";
import {
  buildInitialRequestNotificationParents,
  buildInitialRequestSelections,
  getFamilyGroupRequestSubjectName,
  mapFamilyGroupRequestSearchResults,
  type FamilyGroupRequest,
  type RequestMemberMatch,
} from "@/lib/admin-family-group-ui-helpers";

export interface FamilyGroupRequestReviewSectionProps {
  requests: FamilyGroupRequest[];
  /** Refresh callback fired after a request is approved or rejected. */
  onReviewed: () => void | Promise<void>;
  idPrefix?: string;
  showSearchGuidance?: boolean;
  /**
   * Noun used in the "create a new non-login <noun>" guard message. The admin
   * list phrases this as "member"; the per-group editor phrases it as "adult".
   */
  createMemberNoun?: "member" | "adult";
}

/**
 * Shared request-review list rendered on both the family-groups admin page and
 * inside the family-group editor. Owns the per-request review state (selections,
 * search terms/results, notes, notification parents, errors, and in-flight ids)
 * and the approve/reject/search handlers so neither call site re-implements it.
 * Renders a fragment of cards so the caller's list spacing stays intact.
 */
export function FamilyGroupRequestReviewSection({
  requests,
  onReviewed,
  idPrefix,
  showSearchGuidance = false,
  createMemberNoun = "member",
}: FamilyGroupRequestReviewSectionProps) {
  // Seed the default selections/notification parents from the initial request
  // list so the first paint already shows the auto-selected records (the caller
  // only mounts this section once `requests` is non-empty).
  const [requestSelections, setRequestSelections] = useState<Record<string, string>>(() =>
    buildInitialRequestSelections(requests, {})
  );
  const [requestSearchTerms, setRequestSearchTerms] = useState<Record<string, string>>({});
  const [requestSearchResults, setRequestSearchResults] = useState<Record<string, RequestMemberMatch[]>>({});
  const [requestSearchFeedback, setRequestSearchFeedback] = useState<Record<string, string>>({});
  const [requestNotes, setRequestNotes] = useState<Record<string, string>>({});
  const [requestNotificationParents, setRequestNotificationParents] = useState<Record<string, string>>(() =>
    buildInitialRequestNotificationParents(requests, {})
  );
  const [requestErrors, setRequestErrors] = useState<Record<string, string>>({});
  const [requestSearchingId, setRequestSearchingId] = useState<string | null>(null);
  const [requestSubmittingId, setRequestSubmittingId] = useState<string | null>(null);

  // Re-seed defaults whenever the request list is (re)loaded. Merging with the
  // current maps preserves any in-flight edits for requests that are still
  // present.
  useEffect(() => {
    setRequestSelections((current) => buildInitialRequestSelections(requests, current));
    setRequestNotificationParents((current) =>
      buildInitialRequestNotificationParents(requests, current)
    );
  }, [requests]);

  function clearRequestError(requestId: string) {
    setRequestErrors((current) => {
      if (!current[requestId]) {
        return current;
      }
      const next = { ...current };
      delete next[requestId];
      return next;
    });
  }

  function clearRequestSearchFeedback(requestId: string) {
    setRequestSearchFeedback((current) => {
      if (!current[requestId]) {
        return current;
      }
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

  async function handleRequest(request: FamilyGroupRequest, action: "approve" | "reject") {
    clearRequestError(request.id);

    const linkedMemberId = requestSelections[request.id];
    const needsMemberSelection =
      request.type === "CHILD_REQUEST" || request.type === "ADULT_REQUEST";

    if (action === "approve" && needsMemberSelection && !linkedMemberId) {
      setRequestErrors((current) => ({
        ...current,
        [request.id]: `Choose the member record to link, or create a new non-login ${createMemberNoun} where available.`,
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

      await onReviewed();
    } finally {
      setRequestSubmittingId((current) => (current === request.id ? null : current));
    }
  }

  return (
    <>
      {requests.map((request) => (
        <FamilyGroupRequestReviewCard
          key={request.id}
          idPrefix={idPrefix}
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
          showSearchGuidance={showSearchGuidance}
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
      ))}
    </>
  );
}
