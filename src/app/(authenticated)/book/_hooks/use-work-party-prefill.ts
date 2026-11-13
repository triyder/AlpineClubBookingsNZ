"use client";

import { useEffect, useRef, useState } from "react";

/** What `GET /api/work-parties/[id]` returns that the prefill needs. */
type WorkPartyPrefill = {
  id: string;
  name: string;
  lodgeId: string | null;
  checkIn: string;
  checkOut: string;
};

export const WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE =
  "That work party can no longer be joined, so nothing was filled in. You can still book as usual.";

export const WORK_PARTY_PREFILL_LODGE_NOTICE =
  "You can't book the lodge that work party is held at, so nothing was filled in.";

/**
 * "Join Work Party" (fork #118): `/book?workParty=<id>` opens the booking page
 * with the work party's stay, its lodge and the working-bee option filled in.
 *
 * The work party id is the ONLY input — the dates come from the server
 * (`GET /api/work-parties/[id]`, its `join` stay), never from the URL, so there
 * is one source of them. The member still chooses guests and pays as usual,
 * and every booking rule still applies: the dates go through the wizard's own
 * `handleDateSelect`, exactly as a calendar pick would, and the server
 * re-validates the work party when the booking is created.
 *
 * Steps, each taken once:
 * 1. Fetch the work party. Unknown, inactive, past, or not visible to this
 *    account (the API's 404) → a short notice and nothing filled in.
 * 2. Once the lodge list has loaded, select the work party's lodge (a club-wide
 *    work party keeps the member's own lodge). A lodge the member cannot book
 *    → a notice and nothing filled in.
 * 3. Once that lodge is the settled scope and the wizard is on the dates step,
 *    select the stay.
 * 4. When the review step lists the working bees for the stay, tick this one
 *    (`takePendingSelection`), unless the member has already chosen.
 */
export function useWorkPartyPrefill({
  workPartyId,
  lodgeIds,
  lodgesLoading,
  lodgeId,
  scopedLodgeId,
  onDatesStep,
  selectLodge,
  selectDates,
}: {
  workPartyId: string | null;
  lodgeIds: readonly string[];
  lodgesLoading: boolean;
  lodgeId: string | null;
  scopedLodgeId: string | null;
  onDatesStep: boolean;
  selectLodge: (lodgeId: string) => void;
  selectDates: (checkIn: string, checkOut: string) => void;
}) {
  const [prefill, setPrefill] = useState<WorkPartyPrefill | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const datesAppliedRef = useRef(false);
  const lodgeAppliedRef = useRef(false);
  const pendingSelectionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!workPartyId) return;
    const controller = new AbortController();
    fetch(`/api/work-parties/${encodeURIComponent(workPartyId)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = res.ok ? await res.json() : null;
        const workParty = data?.workParty;
        if (!workParty?.join) {
          setNotice(WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE);
          return;
        }
        pendingSelectionRef.current = workParty.id;
        setPrefill({
          id: workParty.id,
          name: workParty.name,
          lodgeId: workParty.lodgeId ?? null,
          checkIn: workParty.join.checkIn,
          checkOut: workParty.join.checkOut,
        });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setNotice(WORK_PARTY_PREFILL_UNAVAILABLE_NOTICE);
      });
    return () => controller.abort();
  }, [workPartyId]);

  const lodgeRefused =
    prefill?.lodgeId != null &&
    !lodgesLoading &&
    !lodgeIds.includes(prefill.lodgeId);

  useEffect(() => {
    if (!prefill || lodgeAppliedRef.current || lodgesLoading) return;
    lodgeAppliedRef.current = true;
    if (!prefill.lodgeId) return;
    if (lodgeRefused) {
      pendingSelectionRef.current = null;
      datesAppliedRef.current = true;
      setNotice(WORK_PARTY_PREFILL_LODGE_NOTICE);
      return;
    }
    if (lodgeId !== prefill.lodgeId) selectLodge(prefill.lodgeId);
  }, [prefill, lodgesLoading, lodgeRefused, lodgeId, selectLodge]);

  useEffect(() => {
    if (!prefill || datesAppliedRef.current || !lodgeAppliedRef.current) return;
    if (!onDatesStep || !scopedLodgeId) return;
    if (prefill.lodgeId && scopedLodgeId !== prefill.lodgeId) return;
    datesAppliedRef.current = true;
    selectDates(prefill.checkIn, prefill.checkOut);
  }, [prefill, onDatesStep, scopedLodgeId, selectDates]);

  /**
   * The work party to tick on the review step, once: returns its id when it is
   * among the working bees listed for the stay, and clears it either way so a
   * member who unticks it, or changes the dates, is not overridden.
   */
  function takePendingSelection(
    events: ReadonlyArray<{ id: string }>,
  ): string | null {
    const pending = pendingSelectionRef.current;
    if (!pending || !datesAppliedRef.current) return null;
    pendingSelectionRef.current = null;
    return events.some((event) => event.id === pending) ? pending : null;
  }

  return {
    workPartyPrefillNotice: notice,
    workPartyPrefillName: prefill?.name ?? null,
    takePendingWorkPartySelection: takePendingSelection,
  };
}
