"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { shouldDefaultLinkSideEffects } from "@/lib/admin-member-detail-helpers";
import type { LinkParentSearchResult, MemberDetail } from "../_types";

interface UseMemberParentLinkParams {
  member: MemberDetail | null;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setRelationshipError: Dispatch<SetStateAction<string>>;
}

export function useMemberParentLink({
  member,
  fetchMember,
  setLoading,
  setRelationshipError,
}: UseMemberParentLinkParams) {
  const memberId = member?.id;

  const [parentLinkOpen, setParentLinkOpen] = useState(false);
  const [parentLinkSearch, setParentLinkSearch] = useState("");
  const [parentLinkSearchResults, setParentLinkSearchResults] = useState<
    LinkParentSearchResult[]
  >([]);
  const [parentLinkSearching, setParentLinkSearching] = useState(false);
  const [selectedLinkParent, setSelectedLinkParent] =
    useState<LinkParentSearchResult | null>(null);
  const [parentLinkInheritEmail, setParentLinkInheritEmail] = useState(false);
  const [parentLinkNotificationParentId, setParentLinkNotificationParentId] =
    useState("");
  const [parentLinkDisableLogin, setParentLinkDisableLogin] = useState(false);
  const [parentLinkFamilyGroupIds, setParentLinkFamilyGroupIds] = useState<
    string[]
  >([]);
  const [parentLinkSaving, setParentLinkSaving] = useState(false);
  const [parentLinkError, setParentLinkError] = useState("");

  useEffect(() => {
    if (
      !parentLinkOpen ||
      !memberId ||
      (member?.parentLinks?.length ?? 0) >= 2
    ) {
      setParentLinkSearchResults([]);
      setParentLinkSearching(false);
      return;
    }

    const query = parentLinkSearch.trim();
    if (query.length < 2) {
      setParentLinkSearchResults([]);
      setParentLinkSearching(false);
      return;
    }

    let cancelled = false;
    setParentLinkSearching(true);
    setParentLinkError("");

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: "8",
          parentLinkEligibleFor: memberId,
        });
        const res = await fetch(`/api/admin/members?${params.toString()}`);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || "Failed to search parent members");
        }

        if (!cancelled) {
          setParentLinkSearchResults(
            (data.members ?? [])
              .map((candidate: LinkParentSearchResult) => ({
                id: candidate.id,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                email: candidate.email,
                ageTier: candidate.ageTier,
                active: candidate.active,
                canLogin: candidate.canLogin,
                dateOfBirth: candidate.dateOfBirth,
                familyGroups: candidate.familyGroups ?? [],
              }))
              .filter(
                (candidate: LinkParentSearchResult) =>
                  candidate.id !== selectedLinkParent?.id,
              ),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setParentLinkSearchResults([]);
          setParentLinkError(
            error instanceof Error
              ? error.message
              : "Failed to search parent members",
          );
        }
      } finally {
        if (!cancelled) {
          setParentLinkSearching(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    member?.parentLinks?.length,
    memberId,
    parentLinkOpen,
    parentLinkSearch,
    selectedLinkParent?.id,
  ]);

  const openParentLinkDialog = () => {
    if (!member) return;
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier);
    setParentLinkSearch("");
    setParentLinkSearchResults([]);
    setParentLinkSearching(false);
    setSelectedLinkParent(null);
    setParentLinkInheritEmail(defaultSideEffects);
    setParentLinkNotificationParentId("");
    setParentLinkDisableLogin(defaultSideEffects);
    setParentLinkFamilyGroupIds([]);
    setParentLinkError("");
    setParentLinkOpen(true);
  };

  const selectLinkParent = (candidate: LinkParentSearchResult) => {
    if (!member) return;
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier);
    setSelectedLinkParent(candidate);
    setParentLinkInheritEmail(defaultSideEffects);
    setParentLinkNotificationParentId(defaultSideEffects ? candidate.id : "");
    setParentLinkDisableLogin(defaultSideEffects);
    setParentLinkFamilyGroupIds(
      candidate.familyGroups.map((group) => group.id),
    );
    setParentLinkSearch("");
    setParentLinkSearchResults([]);
    setParentLinkError("");
  };

  const clearLinkParent = () => {
    if (!member) return;
    const defaultSideEffects = shouldDefaultLinkSideEffects(member.ageTier);
    setSelectedLinkParent(null);
    setParentLinkInheritEmail(defaultSideEffects);
    setParentLinkNotificationParentId("");
    setParentLinkDisableLogin(defaultSideEffects);
    setParentLinkFamilyGroupIds([]);
    setParentLinkSearch("");
    setParentLinkSearchResults([]);
    setParentLinkError("");
  };

  const toggleParentLinkFamilyGroup = (
    familyGroupId: string,
    checked: boolean,
  ) => {
    setParentLinkFamilyGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, familyGroupId]))
        : current.filter((idValue) => idValue !== familyGroupId),
    );
  };

  const handleLinkParent = async () => {
    if (!member || !selectedLinkParent) return;

    setParentLinkSaving(true);
    setParentLinkError("");
    setRelationshipError("");

    try {
      const res = await fetch(
        `/api/admin/members/${selectedLinkParent.id}/dependents/link`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            memberId: member.id,
            inheritEmail:
              Boolean(parentLinkNotificationParentId) || parentLinkInheritEmail,
            inheritEmailFromId: parentLinkNotificationParentId || null,
            disableLogin: parentLinkDisableLogin,
            addToFamilyGroupIds: parentLinkFamilyGroupIds,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Failed to link parent");
      }

      setParentLinkOpen(false);
      toast.success("Parent linked successfully");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setParentLinkError(
        err instanceof Error ? err.message : "Failed to link parent",
      );
    } finally {
      setParentLinkSaving(false);
    }
  };

  // Suppress unused-variable warnings for state that is still wired into other
  // computations via the closure (inherit flags participate in the inheritEmail
  // request body construction even though they're read inline above).
  void parentLinkInheritEmail;

  return {
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
  };
}
