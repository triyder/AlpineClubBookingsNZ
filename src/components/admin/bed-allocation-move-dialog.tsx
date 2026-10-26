"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  focusConnectedTarget,
  MAIN_REGION_SELECTOR,
  RETURN_FOCUS_REGION_SELECTOR,
} from "@/hooks/use-scroll-to-feedback";
import { Alert } from "@/components/ui/alert";
import { ViewOnlyActionButton } from "@/components/admin/view-only-action";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  BedAllocationMoveApplyResult,
  BedAllocationMoveErrorCode,
  BedAllocationMovePreview,
  BedAllocationMoveScope,
} from "@/lib/bed-allocation-move";

export interface BedAllocationMoveDialogAnchor {
  allocationId: string;
  guestName: string;
  stayDate: string;
}

export interface BedAllocationMoveDialogDestination {
  destinationBedId: string;
  destinationLabel: string;
}

interface BedAllocationMoveDialogTarget
  extends BedAllocationMoveDialogAnchor,
    BedAllocationMoveDialogDestination {}

interface UseBedAllocationMoveDialogOptions {
  canEdit: boolean | undefined;
  onApplied: (result: BedAllocationMoveApplyResult) => void | Promise<void>;
}

function currentReturnFocusTarget(explicitTarget?: HTMLElement | null) {
  if (explicitTarget?.isConnected) return explicitTarget;
  const active =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  if (!active) return null;

  // A destination menu item is portalled and disappears when selected. Keep
  // its stable trigger so closing the move dialog returns to the same chip.
  const menu = active.closest<HTMLElement>('[role="menu"][id]');
  if (menu) {
    const trigger = [...document.querySelectorAll<HTMLElement>("[aria-controls]")]
      .find((candidate) => candidate.getAttribute("aria-controls") === menu.id);
    if (trigger) return trigger;
  }
  return active;
}

/** One stable entry point for pointer, keyboard, and menu move requests. */
export function useBedAllocationMoveDialog(
  options: UseBedAllocationMoveDialogOptions,
) {
  const appliedCallback = options.onApplied;
  const [anchor, setAnchor] = useState<BedAllocationMoveDialogTarget | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [politeAnnouncement, setPoliteAnnouncement] = useState("");
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState("");
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const fallbackFocusRef = useRef<HTMLElement | null>(null);
  const focusAllocationIdRef = useRef<string | null>(null);

  const restoreFocus = useCallback(() => {
    if (focusConnectedTarget(returnFocusRef.current)) return;
    const allocationId = focusAllocationIdRef.current;
    if (allocationId) {
      const replacement = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-bed-allocation-focus-id]",
        ),
      ].find(
        (candidate) =>
          candidate.dataset.bedAllocationFocusId === allocationId,
      );
      if (focusConnectedTarget(replacement ?? null)) {
        returnFocusRef.current = replacement ?? null;
        return;
      }
    }
    focusConnectedTarget(fallbackFocusRef.current);
  }, []);

  const openMoveDialog = useCallback(
    (
      nextAnchor: BedAllocationMoveDialogAnchor,
      destination: BedAllocationMoveDialogDestination,
      focusOrigin?: HTMLElement | null,
    ) => {
      const nextTarget: BedAllocationMoveDialogTarget = {
        ...nextAnchor,
        ...destination,
      };
      const returnTarget = currentReturnFocusTarget(focusOrigin);
      returnFocusRef.current = returnTarget;
      focusAllocationIdRef.current = nextAnchor.allocationId;
      fallbackFocusRef.current =
        returnTarget?.closest<HTMLElement>(RETURN_FOCUS_REGION_SELECTOR) ??
        document.querySelector<HTMLElement>(MAIN_REGION_SELECTOR);
      setAssertiveAnnouncement("");
      setPoliteAnnouncement(
        `Move options opened for ${nextTarget.guestName} to ${nextTarget.destinationLabel}.`,
      );
      setAnchor(nextTarget);
      setOpen(true);
    },
    [],
  );

  const onOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      window.setTimeout(() => {
        restoreFocus();
      }, 0);
    }
  }, [restoreFocus]);

  const announcePolite = useCallback((message: string) => {
    setAssertiveAnnouncement("");
    setPoliteAnnouncement(message);
  }, []);

  const announceAssertive = useCallback((message: string) => {
    setPoliteAnnouncement("");
    setAssertiveAnnouncement(message);
  }, []);

  const onApplied = useCallback(
    async (result: BedAllocationMoveApplyResult) => {
      try {
        await appliedCallback(result);
      } finally {
        // The dashboard refresh may reconcile the chip into another cell. Find
        // its new control by allocation identity after that render settles.
        window.setTimeout(restoreFocus, 0);
      }
    },
    [appliedCallback, restoreFocus],
  );

  const dialog = (
    <>
      {/* These regions never unmount when the modal closes. A confirmed move
          can therefore be announced after Radix restores board focus. */}
      <div role="alert" aria-live="assertive" className="sr-only">
        {assertiveAnnouncement}
      </div>
      <div role="status" aria-live="polite" className="sr-only">
        {politeAnnouncement}
      </div>
      <BedAllocationMoveDialog
        open={open}
        onOpenChange={onOpenChange}
        anchor={anchor}
        canEdit={options.canEdit}
        onApplied={onApplied}
        announcePolite={announcePolite}
        announceAssertive={announceAssertive}
      />
    </>
  );

  return { openMoveDialog, dialog };
}

interface BedAllocationMoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: BedAllocationMoveDialogTarget | null;
  canEdit: boolean | undefined;
  onApplied: (result: BedAllocationMoveApplyResult) => void | Promise<void>;
  announcePolite: (message: string) => void;
  announceAssertive: (message: string) => void;
}

interface MoveErrorBody {
  error?: string;
  code?: BedAllocationMoveErrorCode;
  refreshedPreview?: BedAllocationMovePreview;
}

async function readMoveError(response: Response): Promise<MoveErrorBody> {
  try {
    return (await response.json()) as MoveErrorBody;
  } catch {
    return {};
  }
}

function scopeLabel(scope: BedAllocationMoveScope) {
  return scope === "ALLOCATION_NIGHT"
    ? "this allocation night"
    : "every existing allocation night for this person on this booking";
}

export function BedAllocationMoveDialog({
  open,
  onOpenChange,
  anchor,
  canEdit,
  onApplied,
  announcePolite,
  announceAssertive,
}: BedAllocationMoveDialogProps) {
  const [scope, setScope] = useState<BedAllocationMoveScope>(
    "ALLOCATION_NIGHT",
  );
  const [preview, setPreview] = useState<BedAllocationMovePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [reviewRefreshedPreview, setReviewRefreshedPreview] = useState(false);
  const previewAbortRef = useRef<AbortController | null>(null);
  const requestGenerationRef = useRef(0);
  const applyInFlightRef = useRef(false);
  const applyGenerationRef = useRef(0);
  const openRef = useRef(open);
  const targetKey = anchor
    ? `${anchor.allocationId}\u0000${anchor.destinationBedId}`
    : null;
  const targetKeyRef = useRef<string | null>(targetKey);

  useEffect(() => {
    openRef.current = open;
    targetKeyRef.current = targetKey;
  }, [open, targetKey]);

  const loadPreview = useCallback(
    async (nextScope: BedAllocationMoveScope) => {
      if (!anchor) return;
      const generation = requestGenerationRef.current + 1;
      requestGenerationRef.current = generation;
      previewAbortRef.current?.abort();
      const controller = new AbortController();
      previewAbortRef.current = controller;
      setLoading(true);
      setError("");
      setPreview(null);
      setReviewRefreshedPreview(false);
      try {
        const response = await fetch(
          "/api/admin/bed-allocation/allocations/move",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              anchorAllocationId: anchor.allocationId,
              destinationBedId: anchor.destinationBedId,
              scope: nextScope,
            }),
            signal: controller.signal,
          },
        );
        if (generation !== requestGenerationRef.current) return;
        if (!response.ok) {
          const body = await readMoveError(response);
          const message = body.error ?? "Failed to preview allocation move";
          setError(message);
          announceAssertive(`Move preview failed. ${message}`);
          return;
        }
        const nextPreview = (await response.json()) as BedAllocationMovePreview;
        if (generation !== requestGenerationRef.current) return;
        setPreview(nextPreview);
        announcePolite(
          `Move preview ready: ${nextPreview.changedRowCount} changing and ${nextPreview.unchangedRowCount} unchanged allocation nights.`,
        );
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") return;
        if (generation !== requestGenerationRef.current) return;
        setError("Failed to preview allocation move");
        announceAssertive("Move preview failed. No allocation changed.");
      } finally {
        if (generation === requestGenerationRef.current) setLoading(false);
      }
    },
    [anchor, announceAssertive, announcePolite],
  );

  useEffect(() => {
    if (!open || !anchor) return;
    applyGenerationRef.current += 1;
    applyInFlightRef.current = false;
    setApplying(false);
    setScope("ALLOCATION_NIGHT");
    setPreview(null);
    setError("");
    setReviewRefreshedPreview(false);
    void loadPreview("ALLOCATION_NIGHT");
    return () => previewAbortRef.current?.abort();
  }, [anchor, loadPreview, open]);

  const handleDialogOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && applyInFlightRef.current) return;
      if (!nextOpen) {
        requestGenerationRef.current += 1;
        applyGenerationRef.current += 1;
        previewAbortRef.current?.abort();
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  const exactNights = useMemo(
    () =>
      preview
        ? [...preview.changed, ...preview.unchanged]
            .sort(
              (left, right) =>
                left.stayDate.localeCompare(right.stayDate) ||
                left.allocationId.localeCompare(right.allocationId),
            )
            .map((detail) => ({
              ...detail,
              unchanged: preview.unchanged.some(
                (row) => row.allocationId === detail.allocationId,
              ),
            }))
        : [],
    [preview],
  );

  async function confirmMove() {
    if (!anchor || !preview || !canEdit || applyInFlightRef.current) return;
    applyInFlightRef.current = true;
    const applyGeneration = applyGenerationRef.current + 1;
    applyGenerationRef.current = applyGeneration;
    const applyTargetKey = targetKey;
    const isCurrentApply = () =>
      applyGenerationRef.current === applyGeneration &&
      openRef.current &&
      targetKeyRef.current === applyTargetKey;
    setApplying(true);
    setError("");
    let appliedResult: BedAllocationMoveApplyResult | null = null;
    try {
      const response = await fetch("/api/admin/bed-allocation/allocations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anchorAllocationId: anchor.allocationId,
          destinationBedId: anchor.destinationBedId,
          scope,
          previewDigest: preview.digest,
        }),
      });
      if (!isCurrentApply()) return;
      if (!response.ok) {
        const body = await readMoveError(response);
        if (!isCurrentApply()) return;
        if (body.refreshedPreview) setPreview(body.refreshedPreview);
        const message = body.error ?? "No allocations were moved";
        if (body.code === "STALE_PREVIEW" && body.refreshedPreview) {
          setScope(body.refreshedPreview.scope);
          setReviewRefreshedPreview(true);
          announcePolite(
            "The move preview was stale. Refreshed details are ready; review them and confirm again.",
          );
          setError(message);
          return;
        }
        setReviewRefreshedPreview(false);
        setError(message);
        announceAssertive(`Move failed. ${message} No allocation changed.`);
        return;
      }

      appliedResult = (await response.json()) as BedAllocationMoveApplyResult;
      if (!isCurrentApply()) return;
    } catch {
      if (!isCurrentApply()) return;
      setError("Failed to move allocations");
      announceAssertive("Move failed. No allocation changed.");
    } finally {
      if (isCurrentApply()) {
        applyInFlightRef.current = false;
        setApplying(false);
      }
    }

    if (!appliedResult) return;
    const message = appliedResult.noop
      ? `No change: all ${preview.unchangedRowCount} allocation nights already use ${preview.destination.label}.`
      : `Move confirmed: ${appliedResult.movedRowCount} allocation night${appliedResult.movedRowCount === 1 ? "" : "s"} moved to ${preview.destination.label}.`;
    announcePolite(message);
    onOpenChange(false);
    try {
      await onApplied(appliedResult);
    } catch {
      announceAssertive(
        "Move confirmed, but the allocation board could not refresh. Reload the board to see the saved move.",
      );
    }
  }

  const hasConflicts = Boolean(preview?.conflicts.length);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Move {anchor?.guestName ?? "allocation"} to {anchor?.destinationLabel ?? "bed"}
          </DialogTitle>
          <DialogDescription>
            Choose the exact scope, review every original NZ lodge night, then
            confirm. No move is sent before confirmation.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0">
          {error ? (
            <Alert role="presentation" variant="error">
              {error}
            </Alert>
          ) : null}
        </div>

        <fieldset className="space-y-3" disabled={loading || applying}>
          <legend className="text-sm font-semibold">Move scope</legend>
          {(["ALLOCATION_NIGHT", "BOOKING_GUEST"] as const).map((value) => (
            <label key={value} className="flex items-start gap-3 text-sm">
              <input
                type="radio"
                name="bed-allocation-move-scope"
                value={value}
                checked={scope === value}
                onChange={() => {
                  setScope(value);
                  void loadPreview(value);
                }}
              />
              <span>
                <span className="font-medium">
                  {value === "ALLOCATION_NIGHT"
                    ? `This allocation night (${anchor?.stayDate ?? ""})`
                    : "This person on this booking"}
                </span>
                <span className="block text-muted-foreground">
                  {value === "ALLOCATION_NIGHT"
                    ? "Only the anchored allocation row keeps its original lodge night."
                    : "Every existing allocation row is included, including sparse and off-screen nights; missing guest-nights are not created."}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {loading ? (
          <p className="text-sm">Checking which nights will change…</p>
        ) : null}

        {preview ? (
          <div className="space-y-3 rounded-md border p-3 text-sm">
            <p className="font-semibold">
              {scopeLabel(preview.scope)}: {preview.changedRowCount} changing, {" "}
              {preview.unchangedRowCount} unchanged, {preview.resolvedRowCount} total
            </p>
            <p>
              Destination: <strong>{preview.destination.label}</strong>
            </p>
            <ul className="max-h-48 space-y-1 overflow-y-auto pl-5">
              {exactNights.map((detail) => (
                <li key={detail.allocationId} className="list-disc">
                  {detail.stayDate} — {detail.sourceRoomName} / {detail.sourceBedName}
                  {detail.unchanged ? " (unchanged; already at destination)" : ""}
                  {!detail.unchanged && detail.approved
                    ? " (approved → manual draft)"
                    : ""}
                </li>
              ))}
            </ul>
            {preview.approvedToDraftCount > 0 ? (
              <Alert variant="warning" title="Approved allocations will become drafts">
                {preview.approvedToDraftCount} approved allocation
                {preview.approvedToDraftCount === 1 ? "" : "s"} will become
                unapproved Manual drafts and must be approved again.
              </Alert>
            ) : null}
            {preview.promotions.length > 0 ? (
              <Alert variant="info" title="Shared-double occupants will be promoted">
                {preview.promotions.map((promotion) => (
                  <div key={`${promotion.stayDate}:${promotion.bedName}`}>
                    A remaining shared-double occupant on {promotion.stayDate} at {promotion.bedName}{" "}
                    will become the primary occupant.
                  </div>
                ))}
              </Alert>
            ) : null}
            {hasConflicts ? (
              <Alert variant="error" title="The move cannot be applied">
                <ul className="list-disc pl-5">
                  {preview.conflicts.map((conflict) => (
                    <li key={`${conflict.allocationId}:${conflict.code}`}>
                      {conflict.stayDate ? `${conflict.stayDate}: ` : ""}
                      {conflict.message}
                    </li>
                  ))}
                </ul>
              </Alert>
            ) : null}
            {preview.changedRowCount === 0 ? (
              <Alert variant="info">
                No allocation will change and no approval or audit record will be
                rewritten.
              </Alert>
            ) : null}
            {reviewRefreshedPreview ? (
              <Alert variant="warning" title="Review refreshed details">
                Relevant allocation or destination state changed after your last
                preview. Scope was preserved; confirmation is required again.
              </Alert>
            ) : null}
          </div>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleDialogOpenChange(false)}
            disabled={applying}
          >
            Cancel
          </Button>
          <ViewOnlyActionButton
            type="button"
            onClick={() => void confirmMove()}
            canEdit={canEdit}
            disabled={
              loading || applying || !preview || hasConflicts
            }
          >
            {applying
              ? "Moving…"
              : reviewRefreshedPreview
                ? "Confirm refreshed move"
                : "Confirm move"}
          </ViewOnlyActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
