"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import {
  memberUsesSamePostalAddress,
  shouldDefaultLinkSideEffects,
} from "@/lib/admin-member-detail-helpers";
import {
  NZ_COUNTRY_NAME,
  withDefaultNzCountry,
  type MemberAddressValues,
} from "@/lib/member-address";
import { formatValidationErrorResponse } from "@/lib/format-validation-errors";
import type {
  DependentDialogMode,
  DependentForm,
  LinkDependentSearchResult,
  MemberDetail,
} from "../_types";

const defaultDependentForm: DependentForm = {
  title: "",
  gender: "",
  firstName: "",
  lastName: "",
  email: "",
  dateOfBirth: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  streetAddressLine1: "",
  streetAddressLine2: "",
  streetCity: "",
  streetRegion: "",
  streetPostalCode: "",
  streetCountry: NZ_COUNTRY_NAME,
  postalAddressLine1: "",
  postalAddressLine2: "",
  postalCity: "",
  postalRegion: "",
  postalPostalCode: "",
  postalCountry: NZ_COUNTRY_NAME,
};

interface UseMemberDependentDialogParams {
  member: MemberDetail | null;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}

export function useMemberDependentDialog({
  member,
  fetchMember,
  setLoading,
}: UseMemberDependentDialogParams) {
  const memberId = member?.id;

  const [dependentOpen, setDependentOpen] = useState(false);
  const [dependentForm, setDependentForm] =
    useState<DependentForm>(defaultDependentForm);
  const [dependentPostalSameAsPhysical, setDependentPostalSameAsPhysical] =
    useState(false);
  const [dependentSaving, setDependentSaving] = useState(false);
  const [dependentFormError, setDependentFormError] = useState("");
  const [dependentMode, setDependentMode] =
    useState<DependentDialogMode>("create");
  const [linkDependentSearch, setLinkDependentSearch] = useState("");
  const [linkDependentSearchResults, setLinkDependentSearchResults] = useState<
    LinkDependentSearchResult[]
  >([]);
  const [linkDependentSearching, setLinkDependentSearching] = useState(false);
  const [selectedLinkDependent, setSelectedLinkDependent] =
    useState<LinkDependentSearchResult | null>(null);
  const [linkDependentInheritEmail, setLinkDependentInheritEmail] =
    useState(false);
  const [
    linkDependentNotificationParentId,
    setLinkDependentNotificationParentId,
  ] = useState("");
  const [linkDependentDisableLogin, setLinkDependentDisableLogin] =
    useState(false);
  const [linkDependentFamilyGroupIds, setLinkDependentFamilyGroupIds] =
    useState<string[]>([]);

  useEffect(() => {
    if (!dependentOpen || dependentMode !== "link" || !memberId) {
      setLinkDependentSearchResults([]);
      setLinkDependentSearching(false);
      return;
    }

    const query = linkDependentSearch.trim();
    if (query.length < 2) {
      setLinkDependentSearchResults([]);
      setLinkDependentSearching(false);
      return;
    }

    let cancelled = false;
    setLinkDependentSearching(true);

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: "8",
          dependentLinkEligibleFor: memberId,
        });
        const res = await fetch(`/api/admin/members?${params.toString()}`);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(data.error || "Failed to search members");
        }

        if (!cancelled) {
          setLinkDependentSearchResults(
            (data.members ?? [])
              .map((candidate: LinkDependentSearchResult) => ({
                id: candidate.id,
                firstName: candidate.firstName,
                lastName: candidate.lastName,
                email: candidate.email,
                ageTier: candidate.ageTier,
                active: candidate.active,
                canLogin: candidate.canLogin,
                dateOfBirth: candidate.dateOfBirth,
                parentLinks: candidate.parentLinks ?? [],
              }))
              .filter(
                (candidate: LinkDependentSearchResult) =>
                  candidate.id !== selectedLinkDependent?.id,
              ),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setLinkDependentSearchResults([]);
          setDependentFormError(
            error instanceof Error ? error.message : "Failed to search members",
          );
        }
      } finally {
        if (!cancelled) {
          setLinkDependentSearching(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    dependentMode,
    dependentOpen,
    linkDependentSearch,
    memberId,
    selectedLinkDependent?.id,
  ]);

  const openDependentDialog = () => {
    if (!member) return;

    const inheritedEmailAddress =
      member.inheritEmailFrom?.email || member.email;

    setDependentForm({
      title: "",
      gender: "",
      firstName: "",
      lastName: member.lastName,
      email: inheritedEmailAddress,
      dateOfBirth: "",
      phoneCountryCode: member.phoneCountryCode || "",
      phoneAreaCode: member.phoneAreaCode || "",
      phoneNumber: member.phoneNumber || "",
      streetAddressLine1: member.streetAddressLine1 || "",
      streetAddressLine2: member.streetAddressLine2 || "",
      streetCity: member.streetCity || "",
      streetRegion: member.streetRegion || "",
      streetPostalCode: member.streetPostalCode || "",
      streetCountry: withDefaultNzCountry(member.streetCountry),
      postalAddressLine1: member.postalAddressLine1 || "",
      postalAddressLine2: member.postalAddressLine2 || "",
      postalCity: member.postalCity || "",
      postalRegion: member.postalRegion || "",
      postalPostalCode: member.postalPostalCode || "",
      postalCountry: withDefaultNzCountry(member.postalCountry),
    });
    setDependentPostalSameAsPhysical(
      memberUsesSamePostalAddress({
        streetAddressLine1: member.streetAddressLine1,
        streetAddressLine2: member.streetAddressLine2,
        streetCity: member.streetCity,
        streetRegion: member.streetRegion,
        streetPostalCode: member.streetPostalCode,
        streetCountry: member.streetCountry,
        postalAddressLine1: member.postalAddressLine1,
        postalAddressLine2: member.postalAddressLine2,
        postalCity: member.postalCity,
        postalRegion: member.postalRegion,
        postalPostalCode: member.postalPostalCode,
        postalCountry: member.postalCountry,
      }),
    );
    setDependentFormError("");
    setDependentMode("create");
    setLinkDependentSearch("");
    setLinkDependentSearchResults([]);
    setLinkDependentSearching(false);
    setSelectedLinkDependent(null);
    setLinkDependentInheritEmail(false);
    setLinkDependentNotificationParentId("");
    setLinkDependentDisableLogin(false);
    setLinkDependentFamilyGroupIds(
      member.familyGroups.map((group) => group.id),
    );
    setDependentOpen(true);
  };

  const handleCreateDependent = async () => {
    if (!member) return;

    const inheritedEmailSourceId = member.inheritEmailFromId || member.id;

    setDependentSaving(true);
    setDependentFormError("");

    try {
      const res = await fetch("/api/admin/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: dependentForm.title || null,
          gender: dependentForm.gender || null,
          firstName: dependentForm.firstName,
          lastName: dependentForm.lastName,
          email: dependentForm.email,
          dateOfBirth: dependentForm.dateOfBirth || null,
          phoneCountryCode: dependentForm.phoneCountryCode || null,
          phoneAreaCode: dependentForm.phoneAreaCode || null,
          phoneNumber: dependentForm.phoneNumber || null,
          role: "USER",
          active: true,
          canLogin: false,
          parentMemberId: member.id,
          inheritParentEmail: true,
          inheritEmailFromId: inheritedEmailSourceId,
          familyGroupIds: member.familyGroups.map((group) => group.id),
          streetAddressLine1: dependentForm.streetAddressLine1 || null,
          streetAddressLine2: dependentForm.streetAddressLine2 || null,
          streetCity: dependentForm.streetCity || null,
          streetRegion: dependentForm.streetRegion || null,
          streetPostalCode: dependentForm.streetPostalCode || null,
          streetCountry: dependentForm.streetCountry || null,
          postalAddressLine1: dependentForm.postalAddressLine1 || null,
          postalAddressLine2: dependentForm.postalAddressLine2 || null,
          postalCity: dependentForm.postalCity || null,
          postalRegion: dependentForm.postalRegion || null,
          postalPostalCode: dependentForm.postalPostalCode || null,
          postalCountry: dependentForm.postalCountry || null,
          postalSameAsPhysical: dependentPostalSameAsPhysical,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // Surface per-field zod errors (one line each) instead of a bare
        // "Validation failed"; the dialog renders them with `whitespace-pre-line`.
        throw new Error(
          formatValidationErrorResponse(data, {
            defaultMessage: "Failed to create dependent",
          }).join("\n"),
        );
      }

      setDependentOpen(false);
      toast.success("Dependent created successfully");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setDependentFormError(
        err instanceof Error ? err.message : "Failed to create dependent",
      );
    } finally {
      setDependentSaving(false);
    }
  };

  const selectLinkDependent = (candidate: LinkDependentSearchResult) => {
    const defaultSideEffects = shouldDefaultLinkSideEffects(candidate.ageTier);
    setSelectedLinkDependent(candidate);
    setLinkDependentInheritEmail(defaultSideEffects);
    setLinkDependentNotificationParentId(
      defaultSideEffects ? (member?.id ?? "") : "",
    );
    setLinkDependentDisableLogin(defaultSideEffects);
    setLinkDependentFamilyGroupIds(
      member?.familyGroups.map((group) => group.id) ?? [],
    );
    setLinkDependentSearch("");
    setLinkDependentSearchResults([]);
    setDependentFormError("");
  };

  const clearLinkDependent = () => {
    setSelectedLinkDependent(null);
    setLinkDependentInheritEmail(false);
    setLinkDependentNotificationParentId("");
    setLinkDependentDisableLogin(false);
    setLinkDependentFamilyGroupIds(
      member?.familyGroups.map((group) => group.id) ?? [],
    );
    setLinkDependentSearch("");
    setLinkDependentSearchResults([]);
    setDependentFormError("");
  };

  const toggleLinkFamilyGroup = (familyGroupId: string, checked: boolean) => {
    setLinkDependentFamilyGroupIds((current) =>
      checked
        ? Array.from(new Set([...current, familyGroupId]))
        : current.filter((idValue) => idValue !== familyGroupId),
    );
  };

  const handleLinkDependent = async () => {
    if (!member || !selectedLinkDependent) return;

    setDependentSaving(true);
    setDependentFormError("");

    try {
      const res = await fetch(
        `/api/admin/members/${member.id}/dependents/link`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            memberId: selectedLinkDependent.id,
            inheritEmail:
              Boolean(linkDependentNotificationParentId) ||
              linkDependentInheritEmail,
            inheritEmailFromId: linkDependentNotificationParentId || null,
            disableLogin: linkDependentDisableLogin,
            addToFamilyGroupIds: linkDependentFamilyGroupIds,
          }),
        },
      );
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Failed to link dependent");
      }

      setDependentOpen(false);
      toast.success("Dependent linked successfully");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setDependentFormError(
        err instanceof Error ? err.message : "Failed to link dependent",
      );
    } finally {
      setDependentSaving(false);
    }
  };

  const updateDependentAddressFields = (
    patch: Partial<MemberAddressValues>,
  ) => {
    setDependentForm((current) => ({ ...current, ...patch }));
  };

  // Suppress unused-variable warnings for state that is still wired into other
  // computations via the closure (inherit flags participate in the inheritEmail
  // request body construction even though they're read inline above).
  void linkDependentInheritEmail;

  return {
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
  };
}
