"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";

/** What group components receive to render their unlock-to-edit UI. */
export interface MemberGroupEditState<TForm> {
  editing: boolean;
  form: TForm | null;
  saving: boolean;
  error: string;
  errorRef: RefObject<HTMLDivElement | null>;
  startEdit: () => void;
  cancelEdit: () => void;
  updateForm: (updater: (prev: TForm) => TForm) => void;
  save: () => Promise<void>;
}

interface UseMemberGroupEditParams<TForm> {
  memberId: string;
  /** Snapshot the latest member into a fresh form; null blocks entering edit. */
  buildForm: () => TForm | null;
  /** Emit ONLY this group's fields; PUT /api/admin/members/[id] is partial. */
  buildPayload: (form: TForm) => Record<string, unknown>;
  successMessage: string;
  /** Refetch after a successful save (page passes setLoading + fetchMember). */
  onSaved: () => Promise<void>;
}

// Generic unlock-to-edit state for one group card on the member detail page.
// Groups edit independently: startEdit always resnapshots from the latest
// member and save refetches, so cross-group staleness self-heals without
// locking.
export function useMemberGroupEdit<TForm>({
  memberId,
  buildForm,
  buildPayload,
  successMessage,
  onSaved,
}: UseMemberGroupEditParams<TForm>): MemberGroupEditState<TForm> {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<TForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const errorRef = useRef<HTMLDivElement>(null);
  const { scrollToError } = useScrollToFeedback();

  useEffect(() => {
    if (error) scrollToError(errorRef);
  }, [error, scrollToError]);

  const startEdit = useCallback(() => {
    const nextForm = buildForm();
    if (!nextForm) return;
    setForm(nextForm);
    setError("");
    setEditing(true);
  }, [buildForm]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setForm(null);
    setError("");
  }, []);

  const updateForm = useCallback((updater: (prev: TForm) => TForm) => {
    setForm((current) => (current === null ? current : updater(current)));
  }, []);

  const save = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/members/${memberId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(form)),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Save failed");
      }
      setEditing(false);
      setForm(null);
      toast.success(successMessage);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [buildPayload, form, memberId, onSaved, successMessage]);

  return {
    editing,
    form,
    saving,
    error,
    errorRef,
    startEdit,
    cancelEdit,
    updateForm,
    save,
  };
}
