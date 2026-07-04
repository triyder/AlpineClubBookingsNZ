"use client";

import { useEffect, useRef, useState, use } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { FamilyGroupEditorDialog } from "@/components/admin/family-group-editor-dialog";
import {
  formatMemberAuditLogSummary as formatMemberAuditLogSummaryHelper,
  getAuditActorDisplayName as getAuditActorDisplayNameHelper,
  getMemberDetailBackLabel,
  parseInviteAuditDetails as parseInviteAuditDetailsHelper,
} from "@/lib/admin-member-detail-helpers";
import { resolveInternalReturnPath } from "@/lib/internal-return-path";
import { hasAccessRole, isFullAdmin } from "@/lib/access-roles";
import { toast } from "sonner";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { MemberDetailHeader } from "./_components/member-detail-header";
import { MemberStatsCards } from "./_components/member-stats-cards";
import { MemberInfoCard } from "./_components/member-info-card";
import { MemberDeletionCard } from "./_components/member-deletion-card";
import { MemberLifecycleCard } from "./_components/member-lifecycle-card";
import { MemberParentLinksCard } from "./_components/member-parent-links-card";
import { MemberPromoCodesCard } from "./_components/member-promo-codes-card";
import { MemberDependentsCard } from "./_components/member-dependents-card";
import { MemberCreditCard } from "./_components/member-credit-card";
import { MemberHistoryAccordion } from "./_components/member-history-accordion";
import { MemberSeasonalMembershipCard } from "./_components/member-seasonal-membership-card";
import { MemberCommitteeAssignmentsCard } from "./_components/member-committee-assignments-card";
import { MemberEditDialog } from "./_components/member-edit-dialog";
import { MemberXeroLinkDialog } from "./_components/member-xero-link-dialog";
import { MemberXeroCreateDialog } from "./_components/member-xero-create-dialog";
import { MemberXeroDecisionDialog } from "./_components/member-xero-decision-dialog";
import { MemberParentLinkDialog } from "./_components/member-parent-link-dialog";
import { MemberDependentDialog } from "./_components/member-dependent-dialog";
import { MemberDeleteRequestDialog } from "./_components/member-delete-request-dialog";
import { MemberDeleteReviewDialog } from "./_components/member-delete-review-dialog";
import { useCollapsibleMemberSections } from "./_hooks/use-collapsible-member-sections";
import { useMemberCredits } from "./_hooks/use-member-credits";
import { useMemberLifecycleActions } from "./_hooks/use-member-lifecycle-actions";
import { useMemberDelete } from "./_hooks/use-member-delete";
import { useMemberRelationships } from "./_hooks/use-member-relationships";
import { useMemberParentLink } from "./_hooks/use-member-parent-link";
import { useMemberDependentDialog } from "./_hooks/use-member-dependent-dialog";
import { useMemberXero } from "./_hooks/use-member-xero";
import { useMemberEdit } from "./_hooks/use-member-edit";
import type { MemberDetail } from "./_types";

// Re-exports preserve the existing import paths used by tests and other callers
// that previously imported these helpers from the page route.
export const formatMemberAuditLogSummary = formatMemberAuditLogSummaryHelper;
export const parseInviteAuditDetails = parseInviteAuditDetailsHelper;
export const getAuditActorDisplayName = getAuditActorDisplayNameHelper;

export default function MemberDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();

  const [member, setMember] = useState<MemberDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [relationshipError, setRelationshipError] = useState("");
  const [xeroError, setXeroError] = useState("");
  const relationshipErrorRef = useRef<HTMLDivElement>(null);
  const xeroErrorRef = useRef<HTMLDivElement>(null);
  const { scrollToError } = useScrollToFeedback();

  const fetchMember = async () => {
    try {
      const res = await fetch(`/api/admin/members/${id}`);
      if (!res.ok) {
        setPageError(
          res.status === 404 ? "Member not found" : "Failed to load member",
        );
        setLoading(false);
        return;
      }
      setMember(await res.json());
      setPageError("");
    } catch {
      setPageError("Failed to load member");
    } finally {
      setLoading(false);
    }
  };

  const shouldAutoOpenEdit = searchParams.get("edit") === "true";

  // Dependent dialog state
  const {
    dependentOpen,
    dependentForm,
    dependentPostalSameAsPhysical,
    dependentSaving,
    dependentFormError,
    dependentMode,
    linkDependentSearch,
    linkDependentSearchResults,
    linkDependentSearching,
    selectedLinkDependent,
    linkDependentNotificationParentId,
    linkDependentDisableLogin,
    linkDependentFamilyGroupIds,
    setDependentOpen,
    setDependentForm,
    setDependentPostalSameAsPhysical,
    setDependentFormError,
    setDependentMode,
    setLinkDependentSearch,
    setSelectedLinkDependent,
    setLinkDependentInheritEmail,
    setLinkDependentNotificationParentId,
    setLinkDependentDisableLogin,
    openDependentDialog,
    handleCreateDependent,
    selectLinkDependent,
    clearLinkDependent,
    toggleLinkFamilyGroup,
    handleLinkDependent,
    updateDependentAddressFields,
  } = useMemberDependentDialog({ member, fetchMember, setLoading });

  // Parent link dialog state
  const {
    parentLinkOpen,
    parentLinkSearch,
    parentLinkSearchResults,
    parentLinkSearching,
    selectedLinkParent,
    parentLinkNotificationParentId,
    parentLinkDisableLogin,
    parentLinkFamilyGroupIds,
    parentLinkSaving,
    parentLinkError,
    setParentLinkOpen,
    setParentLinkSearch,
    setSelectedLinkParent,
    setParentLinkInheritEmail,
    setParentLinkNotificationParentId,
    setParentLinkDisableLogin,
    setParentLinkError,
    openParentLinkDialog,
    selectLinkParent,
    clearLinkParent,
    toggleParentLinkFamilyGroup,
    handleLinkParent,
  } = useMemberParentLink({
    member,
    fetchMember,
    setLoading,
    setRelationshipError,
  });
  const { unlinkingDependentId, handleUnlinkDependent } =
    useMemberRelationships({ fetchMember, setLoading, setRelationshipError });
  const [familyGroupEditorId, setFamilyGroupEditorId] = useState<string | null>(
    null,
  );

  // Account credit state
  const {
    creditBalance,
    creditHistory,
    pendingAdjustmentRequests,
    creditLoading,
    creditError,
    showAdjustmentForm,
    adjustmentAmount,
    adjustmentDescription,
    adjustmentSaving,
    adjustmentError,
    reviewingAdjustmentId,
    setAdjustmentAmount,
    setAdjustmentDescription,
    toggleAdjustmentForm,
    handleAdjustmentSubmit,
    handleReviewAdjustmentRequest,
  } = useMemberCredits(id);

  // Lifecycle state
  const {
    archiveReason,
    archiveReviewNotes,
    archiveActionLoading,
    archiveError,
    cancellationReason,
    cancellationSubmitting,
    cancellationError,
    setArchiveReason,
    setArchiveReviewNotes,
    setCancellationReason,
    handleSubmitArchiveRequest,
    handleReviewArchiveRequest,
    handleSubmitCancellationRequest,
  } = useMemberLifecycleActions({ id, fetchMember, setLoading });

  // Xero link/push state
  const {
    xeroSearchOpen,
    xeroSearchQuery,
    xeroSearchResults,
    xeroSearching,
    xeroChoice,
    xeroLinking,
    selectedXeroContactId,
    xeroUnlinking,
    xeroPushing,
    xeroCreateOpen,
    xeroCreateEntranceFeeInvoice,
    xeroEntranceFeeSkipReason,
    xeroEntranceFeeAmount,
    xeroEntranceFeeNarration,
    xeroCreateDecisionOpen,
    xeroCreateDecisionResults,
    xeroDecisionContactId,
    xeroDecisionError,
    setXeroSearchOpen,
    setXeroSearchQuery,
    setXeroSearchResults,
    setXeroChoice,
    setSelectedXeroContactId,
    setXeroCreateOpen,
    setXeroCreateEntranceFeeInvoice,
    setXeroEntranceFeeSkipReason,
    setXeroEntranceFeeAmount,
    setXeroEntranceFeeNarration,
    setXeroCreateDecisionOpen,
    setXeroCreateDecisionResults,
    setXeroDecisionContactId,
    setXeroDecisionError,
    handleXeroSearch,
    handleXeroLink,
    handleXeroUnlink,
    handleXeroPush,
    handleXeroDecisionLink,
    openLinkXero,
    openCreateXero,
  } = useMemberXero({ id, fetchMember, setLoading, setXeroError });

  // Edit dialog state
  const {
    editOpen,
    form,
    editPostalSameAsPhysical,
    saving,
    formError,
    inheritEmailSearch,
    inheritEmailSearchResults,
    inheritEmailSearchError,
    inheritEmailSearching,
    selectedInheritEmailSource,
    setEditOpen,
    setForm,
    setEditPostalSameAsPhysical,
    setInheritEmailSearch,
    openEditDialog,
    handleSave,
    updateEditAddressFields,
    selectInheritEmailSource,
    clearInheritEmailSource,
  } = useMemberEdit({
    id,
    member,
    loading,
    shouldAutoOpenEdit,
    fetchMember,
    setLoading,
    setXeroError,
    setXeroChoice,
    setSelectedXeroContactId,
    setXeroSearchQuery,
    setXeroSearchResults,
    setXeroCreateEntranceFeeInvoice,
  });

  // Delete state
  const {
    deleteDialogOpen,
    deleteReason,
    deleteError,
    deleteSubmitting,
    deleteReviewDialog,
    deleteReviewNote,
    deleteReviewError,
    deleteReviewSubmitting,
    setDeleteDialogOpen,
    setDeleteReason,
    setDeleteError,
    setDeleteReviewDialog,
    setDeleteReviewNote,
    setDeleteReviewError,
    handleCreateDeleteRequest,
    handleReviewDeleteRequest,
  } = useMemberDelete({
    member,
    fetchMember,
    setLoading,
    onDeleted: () => router.push(backHref),
  });

  const { openSections, onValueChange: onSectionsChange } =
    useCollapsibleMemberSections();

  const isAdultMember = member?.ageTier === "ADULT";
  const memberIsArchived = Boolean(member?.archivedAt);
  const memberLifecycleLocked = Boolean(
    member?.cancelledAt || member?.archivedAt,
  );
  const backHref = resolveInternalReturnPath(
    searchParams.get("returnTo"),
    "/admin/members",
  );
  const backLabel = getMemberDetailBackLabel(backHref);
  const currentMemberQuery = searchParams.toString();
  const currentMemberPath = currentMemberQuery
    ? `/admin/members/${id}?${currentMemberQuery}`
    : `/admin/members/${id}`;

  useEffect(() => {
    if (relationshipError) scrollToError(relationshipErrorRef);
  }, [relationshipError, scrollToError]);

  useEffect(() => {
    if (
      xeroError &&
      !xeroSearchOpen &&
      !editOpen &&
      !xeroCreateOpen &&
      !xeroCreateDecisionOpen
    ) {
      scrollToError(xeroErrorRef);
    }
  }, [
    editOpen,
    scrollToError,
    xeroCreateDecisionOpen,
    xeroCreateOpen,
    xeroError,
    xeroSearchOpen,
  ]);

  useEffect(() => {
    fetchMember();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isSelf = session?.user?.id === id;
  const actorIsFullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (loading) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-slate-500">Loading member details...</p>
      </div>
    );
  }
  if (pageError || !member) {
    return (
      <div className="space-y-4">
        <Button variant="outline" onClick={() => router.push(backHref)}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {backLabel}
        </Button>
        <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-md text-sm">
          {pageError || "Member not found"}
        </div>
      </div>
    );
  }

  const lifecycleRequests = member.lifecycleActionRequests ?? [];
  const deleteRequests = lifecycleRequests.filter(
    (request) => request.action === "DELETE",
  );
  const pendingDeleteRequest = deleteRequests.find(
    (request) => request.status === "REQUESTED",
  );
  const deleteBlockers = member.deleteEligibility.blockers;
  const approvalBlockers = deleteBlockers.filter(
    (blocker) => blocker.code !== "pending_delete_request",
  );
  const canReviewPendingDeleteRequest =
    Boolean(pendingDeleteRequest) &&
    pendingDeleteRequest?.requestedBy?.id !== session?.user?.id;
  const archiveRequests = lifecycleRequests.filter(
    (request) => request.action === "ARCHIVE",
  );
  const pendingArchiveRequest =
    archiveRequests.find((request) => request.status === "REQUESTED") ?? null;
  const reviewedArchiveRequests = archiveRequests
    .filter((request) => request.status !== "REQUESTED")
    .slice(0, 3);
  const isArchiveRequester =
    pendingArchiveRequest?.requestedBy?.id === session?.user?.id;
  const canRequestArchive = Boolean(
    member.cancelledAt && !member.archivedAt && !pendingArchiveRequest,
  );
  const openCancellationRequest = member.openCancellationRequest;
  const canRequestCancellation = Boolean(
    hasAccessRole(member, "USER") &&
    member.active &&
    !member.cancelledAt &&
    !member.archivedAt &&
    !openCancellationRequest,
  );

  return (
    <div className="space-y-6">
      <MemberDetailHeader
        member={member}
        backHref={backHref}
        backLabel={backLabel}
        isAdultMember={isAdultMember}
        memberIsArchived={memberIsArchived}
        pendingDeleteRequest={pendingDeleteRequest}
        xeroPushing={xeroPushing}
        xeroUnlinking={xeroUnlinking}
        onOpenDependentDialog={openDependentDialog}
        onOpenLinkXero={openLinkXero}
        onOpenCreateXero={openCreateXero}
        onUnlinkXero={handleXeroUnlink}
        onOpenEditDialog={openEditDialog}
      />

      {relationshipError && (
        <div
          ref={relationshipErrorRef}
          role="alert"
          tabIndex={-1}
          className="scroll-mt-20 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 focus:outline-none"
        >
          {relationshipError}
        </div>
      )}
      {xeroError &&
        !xeroSearchOpen &&
        !editOpen &&
        !xeroCreateOpen &&
        !xeroCreateDecisionOpen && (
          <div
            ref={xeroErrorRef}
            role="alert"
            tabIndex={-1}
            className="scroll-mt-20 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 focus:outline-none"
          >
            {xeroError}
          </div>
        )}

      <MemberStatsCards member={member} />

      <MemberInfoCard
        member={member}
        onEditFamilyGroup={setFamilyGroupEditorId}
      />

      <MemberSeasonalMembershipCard
        member={member}
        onSaved={async () => {
          setLoading(true);
          await fetchMember();
        }}
      />

      <MemberCommitteeAssignmentsCard
        member={member}
        onSaved={async () => {
          setLoading(true);
          await fetchMember();
        }}
      />

      <MemberParentLinksCard
        member={member}
        memberIsArchived={memberIsArchived}
        currentMemberPath={currentMemberPath}
        unlinkingDependentId={unlinkingDependentId}
        onOpenParentLinkDialog={openParentLinkDialog}
        onUnlinkParent={handleUnlinkDependent}
      />

      <MemberPromoCodesCard promoCodes={member.promoCodes} />

      <MemberDependentsCard
        member={member}
        isAdultMember={isAdultMember}
        memberIsArchived={memberIsArchived}
        currentMemberPath={currentMemberPath}
        unlinkingDependentId={unlinkingDependentId}
        onOpenDependentDialog={openDependentDialog}
        onUnlinkDependent={handleUnlinkDependent}
      />

      <MemberHistoryAccordion
        memberId={id}
        subscriptions={member.subscriptions}
        bookings={member.bookings}
        openSections={openSections}
        onValueChange={onSectionsChange}
        creditCard={
          <MemberCreditCard
            creditBalance={creditBalance}
            creditHistory={creditHistory}
            creditLoading={creditLoading}
            creditError={creditError}
            pendingAdjustmentRequests={pendingAdjustmentRequests}
            reviewingAdjustmentId={reviewingAdjustmentId}
            showAdjustmentForm={showAdjustmentForm}
            adjustmentError={adjustmentError}
            adjustmentAmount={adjustmentAmount}
            adjustmentDescription={adjustmentDescription}
            adjustmentSaving={adjustmentSaving}
            onToggleAdjustmentForm={toggleAdjustmentForm}
            onChangeAdjustmentAmount={setAdjustmentAmount}
            onChangeAdjustmentDescription={setAdjustmentDescription}
            onSubmitAdjustment={handleAdjustmentSubmit}
            onReviewAdjustment={handleReviewAdjustmentRequest}
          />
        }
      />

      <MemberLifecycleCard
        member={member}
        pendingArchiveRequest={pendingArchiveRequest}
        reviewedArchiveRequests={reviewedArchiveRequests}
        isArchiveRequester={isArchiveRequester}
        canRequestArchive={canRequestArchive}
        canRequestCancellation={canRequestCancellation}
        openCancellationRequest={openCancellationRequest}
        archiveError={archiveError}
        archiveReason={archiveReason}
        archiveReviewNotes={archiveReviewNotes}
        archiveActionLoading={archiveActionLoading}
        cancellationError={cancellationError}
        cancellationReason={cancellationReason}
        cancellationSubmitting={cancellationSubmitting}
        onChangeArchiveReason={setArchiveReason}
        onChangeArchiveReviewNote={(requestId, value) =>
          setArchiveReviewNotes((current) => ({
            ...current,
            [requestId]: value,
          }))
        }
        onChangeCancellationReason={setCancellationReason}
        onSubmitArchive={handleSubmitArchiveRequest}
        onSubmitCancellation={handleSubmitCancellationRequest}
        onReviewArchive={handleReviewArchiveRequest}
      />

      <MemberDeletionCard
        deleteEligibility={member.deleteEligibility}
        deleteRequests={deleteRequests}
        pendingDeleteRequest={pendingDeleteRequest}
        approvalBlockerCount={approvalBlockers.length}
        canReviewPendingDeleteRequest={canReviewPendingDeleteRequest}
        onOpenRequestDialog={() => {
          setDeleteDialogOpen(true);
          setDeleteReason("");
          setDeleteError("");
        }}
        onOpenReviewDialog={(request, action) => {
          setDeleteReviewDialog({ request, action });
          setDeleteReviewNote("");
          setDeleteReviewError("");
        }}
      />

      <FamilyGroupEditorDialog
        groupId={familyGroupEditorId}
        open={Boolean(familyGroupEditorId)}
        onOpenChange={(open) => {
          if (!open) setFamilyGroupEditorId(null);
        }}
        onChanged={() => {
          toast.success("Family group updated successfully");
          setLoading(true);
          void fetchMember();
        }}
      />

      <MemberXeroLinkDialog
        open={xeroSearchOpen}
        onOpenChange={setXeroSearchOpen}
        member={member}
        query={xeroSearchQuery}
        results={xeroSearchResults}
        searching={xeroSearching}
        linking={xeroLinking}
        error={xeroError}
        onChangeQuery={setXeroSearchQuery}
        onClearError={() => setXeroError("")}
        onSearch={handleXeroSearch}
        onLink={handleXeroLink}
      />

      <MemberXeroCreateDialog
        open={xeroCreateOpen}
        onOpenChange={setXeroCreateOpen}
        member={member}
        pushing={xeroPushing}
        error={xeroError}
        createEntranceFeeInvoice={xeroCreateEntranceFeeInvoice}
        entranceFeeSkipReason={xeroEntranceFeeSkipReason}
        entranceFeeAmount={xeroEntranceFeeAmount}
        entranceFeeNarration={xeroEntranceFeeNarration}
        onChangeCreateEntranceFeeInvoice={setXeroCreateEntranceFeeInvoice}
        onChangeEntranceFeeSkipReason={setXeroEntranceFeeSkipReason}
        onChangeEntranceFeeAmount={setXeroEntranceFeeAmount}
        onChangeEntranceFeeNarration={setXeroEntranceFeeNarration}
        onSubmit={() => handleXeroPush(false)}
      />

      <MemberXeroDecisionDialog
        open={xeroCreateDecisionOpen}
        onOpenChange={(open) => {
          setXeroCreateDecisionOpen(open);
          if (!open) {
            setXeroCreateDecisionResults([]);
            setXeroDecisionContactId("");
            setXeroDecisionError("");
          }
        }}
        member={member}
        results={xeroCreateDecisionResults}
        selectedContactId={xeroDecisionContactId}
        createEntranceFeeInvoice={xeroCreateEntranceFeeInvoice}
        linking={xeroLinking}
        pushing={xeroPushing}
        error={xeroDecisionError}
        onSelectContact={setXeroDecisionContactId}
        onConfirmLink={handleXeroDecisionLink}
        onCreateAnyway={() => handleXeroPush(true)}
      />

      <MemberParentLinkDialog
        open={parentLinkOpen}
        onOpenChange={setParentLinkOpen}
        member={member}
        search={parentLinkSearch}
        searching={parentLinkSearching}
        searchResults={parentLinkSearchResults}
        selected={selectedLinkParent}
        notificationParentId={parentLinkNotificationParentId}
        disableLogin={parentLinkDisableLogin}
        familyGroupIds={parentLinkFamilyGroupIds}
        saving={parentLinkSaving}
        error={parentLinkError}
        onChangeSearch={(value) => {
          setParentLinkSearch(value);
          setSelectedLinkParent(null);
          setParentLinkError("");
        }}
        onSelectCandidate={selectLinkParent}
        onClearSelection={clearLinkParent}
        onChangeNotificationParentId={(value) => {
          setParentLinkNotificationParentId(value);
          setParentLinkInheritEmail(Boolean(value));
        }}
        onChangeDisableLogin={setParentLinkDisableLogin}
        onToggleFamilyGroup={toggleParentLinkFamilyGroup}
        onSubmit={handleLinkParent}
      />

      <MemberDependentDialog
        open={dependentOpen}
        onOpenChange={setDependentOpen}
        member={member}
        mode={dependentMode}
        onChangeMode={(value) => {
          setDependentMode(value);
          setDependentFormError("");
        }}
        error={dependentFormError}
        saving={dependentSaving}
        createForm={dependentForm}
        createPostalSameAsPhysical={dependentPostalSameAsPhysical}
        onChangeCreateForm={setDependentForm}
        onChangeCreatePostalSameAsPhysical={setDependentPostalSameAsPhysical}
        onChangeCreateAddressFields={updateDependentAddressFields}
        onSubmitCreate={handleCreateDependent}
        linkSearch={linkDependentSearch}
        linkSearching={linkDependentSearching}
        linkSearchResults={linkDependentSearchResults}
        linkSelected={selectedLinkDependent}
        linkNotificationParentId={linkDependentNotificationParentId}
        linkDisableLogin={linkDependentDisableLogin}
        linkFamilyGroupIds={linkDependentFamilyGroupIds}
        onChangeLinkSearch={(value) => {
          setLinkDependentSearch(value);
          setSelectedLinkDependent(null);
          setDependentFormError("");
        }}
        onSelectLinkCandidate={selectLinkDependent}
        onClearLinkSelection={clearLinkDependent}
        onChangeLinkNotificationParentId={(value) => {
          setLinkDependentNotificationParentId(value);
          setLinkDependentInheritEmail(Boolean(value));
        }}
        onChangeLinkDisableLogin={setLinkDependentDisableLogin}
        onToggleLinkFamilyGroup={toggleLinkFamilyGroup}
        onSubmitLink={handleLinkDependent}
      />

      <MemberDeleteRequestDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        reason={deleteReason}
        error={deleteError}
        submitting={deleteSubmitting}
        onChangeReason={setDeleteReason}
        onSubmit={handleCreateDeleteRequest}
      />

      <MemberDeleteReviewDialog
        dialog={deleteReviewDialog}
        approvalBlockers={approvalBlockers}
        reviewNote={deleteReviewNote}
        error={deleteReviewError}
        submitting={deleteReviewSubmitting}
        onClose={() => {
          setDeleteReviewDialog(null);
          setDeleteReviewNote("");
          setDeleteReviewError("");
        }}
        onChangeReviewNote={setDeleteReviewNote}
        onSubmit={handleReviewDeleteRequest}
      />

      <MemberEditDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        member={member}
        form={form}
        formError={formError}
        saving={saving}
        isSelf={isSelf}
        actorIsFullAdmin={actorIsFullAdmin}
        memberLifecycleLocked={memberLifecycleLocked}
        postalSameAsPhysical={editPostalSameAsPhysical}
        selectedInheritEmailSource={selectedInheritEmailSource}
        inheritEmailSearch={inheritEmailSearch}
        inheritEmailSearching={inheritEmailSearching}
        inheritEmailSearchError={inheritEmailSearchError}
        inheritEmailSearchResults={inheritEmailSearchResults}
        xeroError={xeroError}
        xeroChoice={xeroChoice}
        xeroSearchQuery={xeroSearchQuery}
        xeroSearchResults={xeroSearchResults}
        xeroSearching={xeroSearching}
        xeroLinking={xeroLinking}
        xeroUnlinking={xeroUnlinking}
        xeroPushing={xeroPushing}
        selectedXeroContactId={selectedXeroContactId}
        onChangeForm={setForm}
        onChangeAddressFields={updateEditAddressFields}
        onChangePostalSameAsPhysical={setEditPostalSameAsPhysical}
        onChangeInheritEmailSearch={setInheritEmailSearch}
        onSelectInheritEmailSource={selectInheritEmailSource}
        onClearInheritEmailSource={clearInheritEmailSource}
        onChangeXeroSearchQuery={setXeroSearchQuery}
        onChangeSelectedXeroContactId={setSelectedXeroContactId}
        onChangeXeroChoice={setXeroChoice}
        onClearXeroError={() => setXeroError("")}
        onOpenLinkXero={openLinkXero}
        onOpenCreateXero={openCreateXero}
        onXeroSearch={handleXeroSearch}
        onXeroLink={handleXeroLink}
        onXeroUnlink={handleXeroUnlink}
        onSubmit={handleSave}
      />
    </div>
  );
}
