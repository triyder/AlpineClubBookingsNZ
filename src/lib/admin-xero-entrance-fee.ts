/**
 * Shared admin-member Xero entrance-fee decision state.
 *
 * Both the admin members list (`/admin/members`) and member detail
 * (`/admin/members/[id]`) pages collect the same four pieces of
 * decision state when pushing a member to Xero:
 *
 *   - whether to create an entrance fee invoice after contact creation
 *   - a skip reason (when no invoice is being raised)
 *   - an amount override (in dollars, optional)
 *   - a narration override (optional)
 *
 * The pages still own their own JSX because the labels and help text
 * diverge intentionally, but the state and validating builder are
 * shared here so the request shape stays consistent.
 */
"use client";

import { useCallback, useState } from "react";

export interface XeroEntranceFeeInvoiceOptions {
  createEntranceFeeInvoice: boolean;
  entranceFeeInvoiceDecision: "CREATE" | "SKIP";
  entranceFeeInvoiceSkipReason?: string;
  entranceFeeInvoiceAmountCents?: number;
  entranceFeeInvoiceNarration?: string;
}

export interface XeroEntranceFeeFormState {
  createEntranceFeeInvoice: boolean;
  skipReason: string;
  amount: string;
  narration: string;
}

// test seam
/**
 * Validate the form state and produce the request payload the admin
 * members API expects. Throws when the inputs are not usable; callers
 * surface the message verbatim.
 */
export function buildXeroEntranceFeeInvoiceOptions(
  state: XeroEntranceFeeFormState,
): XeroEntranceFeeInvoiceOptions {
  if (!state.createEntranceFeeInvoice) {
    const reason = state.skipReason.trim();
    if (!reason) {
      throw new Error("Enter a reason for not raising the joining fee invoice.");
    }

    return {
      createEntranceFeeInvoice: false,
      entranceFeeInvoiceDecision: "SKIP",
      entranceFeeInvoiceSkipReason: reason,
    };
  }

  const amountText = state.amount.trim();
  let amountCents: number | undefined;
  if (amountText) {
    const parsedAmount = Number(amountText);
    amountCents = Math.round(parsedAmount * 100);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || amountCents <= 0) {
      throw new Error(
        "Enter a valid joining fee amount, or leave it blank to use the configured amount.",
      );
    }
  }

  const narration = state.narration.trim();

  return {
    createEntranceFeeInvoice: true,
    entranceFeeInvoiceDecision: "CREATE",
    ...(amountCents ? { entranceFeeInvoiceAmountCents: amountCents } : {}),
    ...(narration ? { entranceFeeInvoiceNarration: narration } : {}),
  };
}

export interface UseXeroEntranceFeeDecisionResult {
  xeroCreateEntranceFeeInvoice: boolean;
  setXeroCreateEntranceFeeInvoice: (value: boolean) => void;
  xeroEntranceFeeSkipReason: string;
  setXeroEntranceFeeSkipReason: (value: string) => void;
  xeroEntranceFeeAmount: string;
  setXeroEntranceFeeAmount: (value: string) => void;
  xeroEntranceFeeNarration: string;
  setXeroEntranceFeeNarration: (value: string) => void;
  resetXeroEntranceFeeDecision: () => void;
  buildXeroEntranceFeeInvoiceOptions: () => XeroEntranceFeeInvoiceOptions;
}

/**
 * State container for the Xero entrance-fee decision controls.
 * Returns named fields matching the pages' existing variable names
 * so the JSX call sites stay unchanged.
 */
export function useXeroEntranceFeeDecision(): UseXeroEntranceFeeDecisionResult {
  const [xeroCreateEntranceFeeInvoice, setXeroCreateEntranceFeeInvoice] = useState(false);
  const [xeroEntranceFeeSkipReason, setXeroEntranceFeeSkipReason] = useState("");
  const [xeroEntranceFeeAmount, setXeroEntranceFeeAmount] = useState("");
  const [xeroEntranceFeeNarration, setXeroEntranceFeeNarration] = useState("");

  const resetXeroEntranceFeeDecision = useCallback(() => {
    setXeroCreateEntranceFeeInvoice(false);
    setXeroEntranceFeeSkipReason("");
    setXeroEntranceFeeAmount("");
    setXeroEntranceFeeNarration("");
  }, []);

  const build = useCallback(
    () =>
      buildXeroEntranceFeeInvoiceOptions({
        createEntranceFeeInvoice: xeroCreateEntranceFeeInvoice,
        skipReason: xeroEntranceFeeSkipReason,
        amount: xeroEntranceFeeAmount,
        narration: xeroEntranceFeeNarration,
      }),
    [
      xeroCreateEntranceFeeInvoice,
      xeroEntranceFeeSkipReason,
      xeroEntranceFeeAmount,
      xeroEntranceFeeNarration,
    ],
  );

  return {
    xeroCreateEntranceFeeInvoice,
    setXeroCreateEntranceFeeInvoice,
    xeroEntranceFeeSkipReason,
    setXeroEntranceFeeSkipReason,
    xeroEntranceFeeAmount,
    setXeroEntranceFeeAmount,
    xeroEntranceFeeNarration,
    setXeroEntranceFeeNarration,
    resetXeroEntranceFeeDecision,
    buildXeroEntranceFeeInvoiceOptions: build,
  };
}
