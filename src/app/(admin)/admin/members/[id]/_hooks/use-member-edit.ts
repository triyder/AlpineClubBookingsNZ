"use client";

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { toast } from "sonner";
import type { XeroSearchResult } from "@/components/admin/xero-suggested-contact-card";
import {
  memberUsesSamePostalAddress,
} from "@/lib/admin-member-detail-helpers";
import {
  withDefaultNzCountry,
  type MemberAddressValues,
} from "@/lib/member-address";
import type {
  EditForm,
  EmailInheritanceSearchResult,
  MemberDetail,
} from "../_types";

const defaultEditForm: EditForm = {
  title: "",
  firstName: "",
  lastName: "",
  gender: "",
  email: "",
  phoneCountryCode: "",
  phoneAreaCode: "",
  phoneNumber: "",
  dateOfBirth: "",
  joinedDate: "",
  lifeMemberDate: "",
  occupation: "",
  comments: "",
  role: "USER",
  accessRoles: ["USER"],
  ageTier: "ADULT",
  financeAccessLevel: "NONE",
  active: true,
  canLogin: true,
  forcePasswordChange: false,
  requiresInduction: false,
  inheritEmailFromId: null,
  streetAddressLine1: "",
  streetAddressLine2: "",
  streetCity: "",
  streetRegion: "",
  streetPostalCode: "",
  streetCountry: "",
  postalAddressLine1: "",
  postalAddressLine2: "",
  postalCity: "",
  postalRegion: "",
  postalPostalCode: "",
  postalCountry: "",
};

interface UseMemberEditParams {
  id: string;
  member: MemberDetail | null;
  loading: boolean;
  shouldAutoOpenEdit: boolean;
  fetchMember: () => Promise<void>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  setXeroError: Dispatch<SetStateAction<string>>;
  setXeroChoice: Dispatch<SetStateAction<"" | "change">>;
  setSelectedXeroContactId: Dispatch<SetStateAction<string>>;
  setXeroSearchQuery: Dispatch<SetStateAction<string>>;
  setXeroSearchResults: Dispatch<SetStateAction<XeroSearchResult[]>>;
  setXeroCreateEntranceFeeInvoice: (value: boolean) => void;
}

export function useMemberEdit({
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
}: UseMemberEditParams) {
  const memberId = member?.id;

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<EditForm>(defaultEditForm);
  const [editPostalSameAsPhysical, setEditPostalSameAsPhysical] =
    useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [hasHandledInitialEditParam, setHasHandledInitialEditParam] =
    useState(false);
  const [inheritEmailSearch, setInheritEmailSearch] = useState("");
  const [inheritEmailSearchResults, setInheritEmailSearchResults] = useState<
    EmailInheritanceSearchResult[]
  >([]);
  const [inheritEmailSearchError, setInheritEmailSearchError] = useState("");
  const [inheritEmailSearching, setInheritEmailSearching] = useState(false);
  const [selectedInheritEmailSource, setSelectedInheritEmailSource] =
    useState<EmailInheritanceSearchResult | null>(null);

  useEffect(() => {
    setHasHandledInitialEditParam(false);
  }, [id]);

  useEffect(() => {
    if (!editOpen || !memberId || form.canLogin) {
      setInheritEmailSearchResults([]);
      setInheritEmailSearchError("");
      setInheritEmailSearching(false);
      return;
    }

    const query = inheritEmailSearch.trim();
    if (query.length < 2) {
      setInheritEmailSearchResults([]);
      setInheritEmailSearchError("");
      setInheritEmailSearching(false);
      return;
    }

    let cancelled = false;
    setInheritEmailSearching(true);
    setInheritEmailSearchError("");

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          q: query,
          pageSize: "8",
          inheritEmailEligible: "true",
          excludeId: memberId,
        });
        const res = await fetch(`/api/admin/members?${params.toString()}`);
        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          throw new Error(
            data.error || "Failed to search eligible adult members",
          );
        }

        if (!cancelled) {
          setInheritEmailSearchResults(
            (data.members ?? [])
              .map(
                (candidate: {
                  id: string;
                  firstName: string;
                  lastName: string;
                  email: string;
                  active: boolean;
                }) => ({
                  id: candidate.id,
                  firstName: candidate.firstName,
                  lastName: candidate.lastName,
                  email: candidate.email,
                  active: candidate.active,
                }),
              )
              .filter(
                (candidate: EmailInheritanceSearchResult) =>
                  candidate.id !== selectedInheritEmailSource?.id,
              ),
          );
        }
      } catch (error) {
        if (!cancelled) {
          setInheritEmailSearchResults([]);
          setInheritEmailSearchError(
            error instanceof Error
              ? error.message
              : "Failed to search eligible adult members",
          );
        }
      } finally {
        if (!cancelled) {
          setInheritEmailSearching(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    editOpen,
    form.canLogin,
    inheritEmailSearch,
    memberId,
    selectedInheritEmailSource?.id,
  ]);

  const openEditDialog = useCallback(() => {
    if (!member) return;
    setForm({
      title: member.title ?? "",
      firstName: member.firstName,
      lastName: member.lastName,
      gender: member.gender ?? "",
      email: member.email,
      phoneCountryCode: member.phoneCountryCode || "",
      phoneAreaCode: member.phoneAreaCode || "",
      phoneNumber: member.phoneNumber || "",
      dateOfBirth: member.dateOfBirth
        ? new Date(member.dateOfBirth).toISOString().split("T")[0]
        : "",
      joinedDate: member.joinedDate
        ? new Date(member.joinedDate).toISOString().split("T")[0]
        : "",
      lifeMemberDate: member.lifeMemberDate
        ? new Date(member.lifeMemberDate).toISOString().split("T")[0]
        : "",
      occupation: member.occupation ?? "",
      comments: member.comments || "",
      role: member.role,
      accessRoles: member.accessRoles,
      ageTier: member.ageTier,
      financeAccessLevel: member.financeAccessLevel,
      active: member.active,
      canLogin: member.canLogin,
      forcePasswordChange: member.forcePasswordChange,
      requiresInduction: member.requiresInduction,
      inheritEmailFromId: member.inheritEmailFromId,
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
    setSelectedInheritEmailSource(
      member.inheritEmailFrom
        ? {
            id: member.inheritEmailFrom.id,
            firstName: member.inheritEmailFrom.firstName,
            lastName: member.inheritEmailFrom.lastName,
            email: member.inheritEmailFrom.email,
          }
        : null,
    );
    setInheritEmailSearch("");
    setInheritEmailSearchResults([]);
    setInheritEmailSearchError("");
    setXeroChoice("");
    setSelectedXeroContactId("");
    setXeroSearchQuery("");
    setXeroSearchResults([]);
    setXeroCreateEntranceFeeInvoice(false);
    setXeroError("");
    setEditPostalSameAsPhysical(
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
    setFormError("");
    setEditOpen(true);
  }, [
    member,
    setSelectedXeroContactId,
    setXeroChoice,
    setXeroCreateEntranceFeeInvoice,
    setXeroError,
    setXeroSearchQuery,
    setXeroSearchResults,
  ]);

  useEffect(() => {
    if (
      hasHandledInitialEditParam ||
      !shouldAutoOpenEdit ||
      loading ||
      !member
    ) {
      return;
    }

    openEditDialog();
    setHasHandledInitialEditParam(true);
  }, [
    hasHandledInitialEditParam,
    loading,
    member,
    openEditDialog,
    shouldAutoOpenEdit,
  ]);

  const handleSave = async () => {
    setSaving(true);
    setFormError("");
    try {
      const res = await fetch(`/api/admin/members/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title || null,
          firstName: form.firstName,
          lastName: form.lastName,
          gender: form.gender || null,
          email: form.email,
          phoneCountryCode: form.phoneCountryCode || null,
          phoneAreaCode: form.phoneAreaCode || null,
          phoneNumber: form.phoneNumber || null,
          dateOfBirth: form.dateOfBirth || null,
          joinedDate: form.joinedDate || null,
          lifeMemberDate: form.lifeMemberDate || null,
          occupation: form.occupation || null,
          comments: form.comments || null,
          role: form.role,
          accessRoles: form.accessRoles,
          ageTier: form.ageTier,
          financeAccessLevel: form.financeAccessLevel,
          active: form.active,
          canLogin: form.canLogin,
          forcePasswordChange: form.forcePasswordChange,
          requiresInduction: form.requiresInduction,
          inheritEmailFromId: form.inheritEmailFromId || null,
          streetAddressLine1: form.streetAddressLine1 || null,
          streetAddressLine2: form.streetAddressLine2 || null,
          streetCity: form.streetCity || null,
          streetRegion: form.streetRegion || null,
          streetPostalCode: form.streetPostalCode || null,
          streetCountry: form.streetCountry || null,
          postalAddressLine1: form.postalAddressLine1 || null,
          postalAddressLine2: form.postalAddressLine2 || null,
          postalCity: form.postalCity || null,
          postalRegion: form.postalRegion || null,
          postalPostalCode: form.postalPostalCode || null,
          postalCountry: form.postalCountry || null,
          postalSameAsPhysical: editPostalSameAsPhysical,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Save failed");
      }
      setEditOpen(false);
      toast.success("Member updated successfully");
      setLoading(true);
      await fetchMember();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const updateEditAddressFields = (patch: Partial<MemberAddressValues>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const selectInheritEmailSource = (source: EmailInheritanceSearchResult) => {
    setSelectedInheritEmailSource(source);
    setForm((current) => ({ ...current, inheritEmailFromId: source.id }));
    setInheritEmailSearch("");
    setInheritEmailSearchResults([]);
    setInheritEmailSearchError("");
  };

  const clearInheritEmailSource = () => {
    setSelectedInheritEmailSource(null);
    setForm((current) => ({ ...current, inheritEmailFromId: null }));
    setInheritEmailSearch("");
    setInheritEmailSearchResults([]);
    setInheritEmailSearchError("");
  };

  return {
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
  };
}
