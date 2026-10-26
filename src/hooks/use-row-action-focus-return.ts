"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  captureFocusReturn,
  RETURN_FOCUS_REGION_ATTRIBUTE,
  RETURN_FOCUS_TRIGGER_ATTRIBUTE,
  useReturnAttention,
  type FocusReturnAnchor,
} from "@/hooks/use-scroll-to-feedback";

/**
 * The markers a list's `useEditorFocusReturn` puts on its row buttons
 * (`triggerProps(key)`) and its card (`regionProps`), by which a row write's
 * return finds its targets.
 */
export interface RowFocusMarkers {
  triggerProps: (key: string) => Record<string, string>;
  regionProps: { [RETURN_FOCUS_REGION_ATTRIBUTE]: string };
}

/**
 * RETURN after a list row's direct write — Activate/Deactivate, Delete — whose
 * refresh unmounted or disabled the button that held focus (#4116). It is built
 * only from the exported primitives of `use-scroll-to-feedback.ts`, and finds
 * its targets by `useEditorFocusReturn`'s own markers
 * (`use-editor-focus-return.ts`), so the trigger and region ids are already
 * shared. What stays separate, on purpose (#4115 reconciled the two), is the
 * anchor-plus-key: here an ACTION'S anchor is bound when `close` runs, last
 * close wins, and `null` returns nowhere; there the HOOK'S one anchor is read
 * when the return effect runs and consumed, so two closes in one render still
 * return once and a close with no fresh open returns nowhere. One helper would
 * have to pick one of those and change the other's edge case.
 *
 * The anchor is the ACTION'S, not the hook's: `capture(key)` hands it back and
 * `close(anchor)` returns through exactly that one, so a write that overlaps
 * another, or an open row editor's own capture, never consumes or replaces it.
 *
 *  - `capture(key)` from the action, naming the row button to land on; the
 *    pressed button is tried first while it is still mounted (a failed write
 *    that refreshed nothing);
 *  - `close(anchor, nextKey)` once the refresh has been applied. `nextKey`
 *    re-aims a write that removed its row at another row's button, or with
 *    `null` straight at the card.
 *
 * After a delete, aim at a row's Edit — never its toggle or Delete, so a stray
 * Enter cannot undo or repeat it. When two closes land in one render, the
 * later one's anchor is the one returned through.
 */
export function useRowActionFocusReturn({
  triggerProps,
  regionProps,
}: RowFocusMarkers) {
  const anchorRef = useRef<FocusReturnAnchor | null>(null);
  const [returnKey, setReturnKey] = useState(0);
  useReturnAttention(anchorRef, returnKey);
  const regionId = regionProps[RETURN_FOCUS_REGION_ATTRIBUTE];
  const markerFor = useCallback(
    (key: string) => triggerProps(key)[RETURN_FOCUS_TRIGGER_ATTRIBUTE],
    [triggerProps],
  );
  const capture = useCallback(
    (key: string) => captureFocusReturn({ triggerId: markerFor(key), regionId }),
    [markerFor, regionId],
  );
  const close = useCallback(
    (anchor: FocusReturnAnchor | null, nextKey?: string | null) => {
      anchorRef.current =
        anchor && nextKey !== undefined
          ? {
              ...anchor,
              trigger: null,
              triggerId: nextKey === null ? undefined : markerFor(nextKey),
            }
          : anchor;
      setReturnKey((count) => count + 1);
    },
    [markerFor],
  );
  return useMemo(() => ({ capture, close }), [capture, close]);
}
