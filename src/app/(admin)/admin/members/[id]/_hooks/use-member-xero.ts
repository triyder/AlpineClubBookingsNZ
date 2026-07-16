"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card";
import { useXeroEntranceFeeDecision } from "@/lib/admin-xero-entrance-fee";
import {
  linkMemberXeroContact,
  pushMemberToXero,
  searchXeroContacts,
  unlinkMemberXeroContact,
  type XeroPushResponse,
} from "@/lib/admin-member-xero-actions";

interface UseMemberXeroParams {
  id: string;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setXeroError: Dispatch<SetStateAction<string>>;
}

export function useMemberXero({
  id,
  fetchMember,
  setLoading,
  setXeroError,
}: UseMemberXeroParams) {
  const [xeroSearchOpen, setXeroSearchOpen] = useState(false);
  const [xeroSearchQuery, setXeroSearchQuery] = useState("");
  const [xeroSearchResults, setXeroSearchResults] = useState<
    XeroSearchResult[]
  >([]);
  const [xeroSearching, setXeroSearching] = useState(false);
  const [xeroChoice, setXeroChoice] = useState<"" | "change">("");
  const [xeroLinking, setXeroLinking] = useState(false);
  const [selectedXeroContactId, setSelectedXeroContactId] = useState("");
  const [xeroUnlinking, setXeroUnlinking] = useState(false);
  const [xeroPushing, setXeroPushing] = useState(false);
  const [xeroCreateOpen, setXeroCreateOpen] = useState(false);
  const {
    xeroCreateEntranceFeeInvoice,
    setXeroCreateEntranceFeeInvoice,
    xeroEntranceFeeSkipReason,
    setXeroEntranceFeeSkipReason,
    xeroEntranceFeeAmount,
    setXeroEntranceFeeAmount,
    xeroEntranceFeeNarration,
    setXeroEntranceFeeNarration,
    resetXeroEntranceFeeDecision,
    buildXeroEntranceFeeInvoiceOptions,
  } = useXeroEntranceFeeDecision();
  const [xeroCreateDecisionOpen, setXeroCreateDecisionOpen] = useState(false);
  const [xeroCreateDecisionResults, setXeroCreateDecisionResults] = useState<
    XeroSearchResult[]
  >([]);
  const [xeroDecisionContactId, setXeroDecisionContactId] = useState("");
  const [xeroDecisionError, setXeroDecisionError] = useState("");

  const handleXeroSearch = async () => {
    if (!xeroSearchQuery || xeroSearchQuery.length < 2) return;
    setXeroSearching(true);
    setXeroError("");
    try {
      const contacts = await searchXeroContacts(xeroSearchQuery);
      setXeroSearchResults(contacts);
    } catch (err) {
      setXeroSearchResults([]);
      setXeroError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setXeroSearching(false);
    }
  };

  const handleXeroLink = async (xeroContactId: string) => {
    setXeroLinking(true);
    setXeroError("");
    try {
      await linkMemberXeroContact(id, xeroContactId);
      setXeroChoice("");
      setSelectedXeroContactId("");
      setXeroSearchQuery("");
      setXeroSearchResults([]);
      setXeroSearchOpen(false);
      toast.success("Member linked to Xero contact");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setXeroError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setXeroLinking(false);
    }
  };

  const handleXeroUnlink = async () => {
    setXeroUnlinking(true);
    setXeroError("");
    try {
      await unlinkMemberXeroContact(id);
      setXeroChoice("");
      setSelectedXeroContactId("");
      setXeroSearchQuery("");
      setXeroSearchResults([]);
      resetXeroEntranceFeeDecision();
      toast.success("Member unlinked from Xero");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setXeroError(err instanceof Error ? err.message : "Unlink failed");
    } finally {
      setXeroUnlinking(false);
    }
  };

  const applyXeroPushSuccess = async (
    data: XeroPushResponse,
    createEntranceFeeInvoice: boolean,
  ) => {
    setXeroChoice("");
    setSelectedXeroContactId("");
    setXeroSearchQuery("");
    setXeroSearchResults([]);
    setXeroCreateOpen(false);
    setXeroCreateDecisionOpen(false);
    setXeroCreateDecisionResults([]);
    setXeroDecisionContactId("");
    setXeroDecisionError("");
    toast.success(createEntranceFeeInvoice && data.entranceFeeInvoiceQueued
        ? "Member created in Xero and joining fee invoice queued"
        : "Member created in Xero",);

    const warning =
      typeof data.warning === "string"
        ? data.warning
        : createEntranceFeeInvoice &&
            typeof data.entranceFeeInvoiceMessage === "string" &&
            !data.entranceFeeInvoiceQueued
          ? data.entranceFeeInvoiceMessage
          : "";

    if (warning) {
      setXeroError(warning);
    }

    setLoading(true);
    await fetchMember();
  };

  const handleXeroPush = async (forceCreate = false) => {
    setXeroPushing(true);
    setXeroError("");
    if (forceCreate) {
      setXeroDecisionError("");
    }
    try {
      const entranceFeeInvoiceOptions = buildXeroEntranceFeeInvoiceOptions();
      const result = await pushMemberToXero(id, {
        ...entranceFeeInvoiceOptions,
        forceCreate,
      });
      if (result.status === "needsDecision") {
        setXeroCreateOpen(false);
        setXeroCreateDecisionResults(result.suggestedContacts);
        setXeroDecisionContactId(
          result.suggestedContacts.find((contact) => !contact.isLinked)
            ?.contactId ?? "",
        );
        setXeroDecisionError("");
        setXeroCreateDecisionOpen(true);
        return;
      }

      await applyXeroPushSuccess(
        result.data,
        entranceFeeInvoiceOptions.createEntranceFeeInvoice,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Push failed";
      if (forceCreate) {
        setXeroDecisionError(message);
      } else {
        setXeroError(message);
      }
    } finally {
      setXeroPushing(false);
    }
  };

  const handleXeroDecisionLink = async () => {
    if (!xeroDecisionContactId) return;

    setXeroLinking(true);
    setXeroDecisionError("");
    try {
      await linkMemberXeroContact(id, xeroDecisionContactId);
      setXeroChoice("");
      setSelectedXeroContactId("");
      setXeroSearchQuery("");
      setXeroSearchResults([]);
      setXeroCreateDecisionOpen(false);
      setXeroCreateDecisionResults([]);
      setXeroDecisionContactId("");
      toast.success("Member linked to Xero contact");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setXeroDecisionError(err instanceof Error ? err.message : "Link failed");
    } finally {
      setXeroLinking(false);
    }
  };

  const openLinkXero = () => {
    setXeroSearchOpen(true);
    setXeroSearchQuery("");
    setXeroSearchResults([]);
    setXeroError("");
  };

  const openCreateXero = () => {
    resetXeroEntranceFeeDecision();
    setXeroCreateOpen(true);
    setXeroError("");
  };

  return {
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
  };
}
