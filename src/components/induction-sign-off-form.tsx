"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  type InductionDetailClient,
  type InductionItemResultValue,
  INDUCTION_RESULT_LABELS,
  SELF_ASSESSMENT_LABELS,
} from "@/lib/induction-display";

interface ItemDraft {
  result: InductionItemResultValue | "";
  explanationProvided: boolean;
  demonstrationProvided: boolean;
  notes: string;
}

const RESULT_OPTIONS: InductionItemResultValue[] = ["YES", "NO", "NOT_APPLICABLE"];

function buildInitialDrafts(detail: InductionDetailClient): Record<string, ItemDraft> {
  const byItem = new Map(detail.itemResults.map((r) => [r.itemId, r]));
  const drafts: Record<string, ItemDraft> = {};
  for (const section of detail.template.sections) {
    for (const item of section.items) {
      const existing = byItem.get(item.id);
      drafts[item.id] = {
        result: existing?.result ?? "",
        explanationProvided: existing?.explanationProvided ?? false,
        demonstrationProvided: existing?.demonstrationProvided ?? false,
        notes: existing?.notes ?? "",
      };
    }
  }
  return drafts;
}

export function InductionSignOffForm({
  inductionId,
  onComplete,
  onCancel,
}: {
  inductionId: string;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [detail, setDetail] = useState<InductionDetailClient | null>(null);
  const [declaration, setDeclaration] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ItemDraft>>({});
  const [declarationAccepted, setDeclarationAccepted] = useState(false);
  const [comments, setComments] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/inductions/${inductionId}`, { credentials: "same-origin" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(body.error ?? "Failed to load the induction.");
          return;
        }
        const body = (await res.json()) as {
          induction: InductionDetailClient;
          declaration: string;
        };
        if (cancelled) return;
        setDetail(body.induction);
        setDeclaration(body.declaration);
        setDrafts(buildInitialDrafts(body.induction));
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load the induction.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inductionId]);

  function updateItem(itemId: string, patch: Partial<ItemDraft>) {
    setDrafts((prev) => ({ ...prev, [itemId]: { ...prev[itemId], ...patch } }));
  }

  async function handleSubmit() {
    if (!declarationAccepted) {
      toast.error("Please accept the declaration before signing off.");
      return;
    }
    setSubmitting(true);
    const itemResults = Object.entries(drafts)
      .filter(([, draft]) => draft.result !== "")
      .map(([itemId, draft]) => ({
        itemId,
        result: draft.result as InductionItemResultValue,
        explanationProvided: draft.explanationProvided,
        demonstrationProvided: draft.demonstrationProvided,
        notes: draft.notes.trim() || null,
      }));

    try {
      const res = await fetch(`/api/inductions/${inductionId}/sign-off`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          declarationAccepted: true,
          comments: comments.trim() || null,
          itemResults,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to record sign-off.");
        return;
      }
      toast.success(
        body.completed
          ? "Induction sign-off recorded — the induction is now complete."
          : "Induction sign-off recorded."
      );
      onComplete();
    } catch {
      toast.error("Failed to record sign-off.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading induction…</p>;
  }
  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!detail) {
    return null;
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Signing off the lodge induction for{" "}
        <strong className="text-foreground">
          {detail.member.firstName} {detail.member.lastName}
        </strong>
        . Work through each item with them, then accept the declaration and sign off.
      </p>

      {detail.template.sections.map((section) => (
        <div key={section.id} className="space-y-3">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {section.title}
          </h4>
          <ul className="space-y-4">
            {section.items.map((item) => {
              const draft = drafts[item.id];
              return (
                <li key={item.id} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {item.label}
                        {item.isMandatory && (
                          <span className="ml-2 text-xs font-normal text-destructive">
                            Mandatory
                          </span>
                        )}
                        {detail.selfAssessment?.[item.id] && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            Member: {SELF_ASSESSMENT_LABELS[detail.selfAssessment[item.id]]}
                          </span>
                        )}
                      </p>
                      {item.competencyPrompt && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {item.competencyPrompt}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {RESULT_OPTIONS.map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => updateItem(item.id, { result: option })}
                          className={cn(
                            "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                            draft?.result === option
                              ? "border-primary bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent"
                          )}
                        >
                          {INDUCTION_RESULT_LABELS[option]}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={draft?.explanationProvided ?? false}
                        onCheckedChange={(checked) =>
                          updateItem(item.id, { explanationProvided: checked === true })
                        }
                      />
                      Explained
                    </label>
                    {item.requiresDemonstration && (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Checkbox
                          checked={draft?.demonstrationProvided ?? false}
                          onCheckedChange={(checked) =>
                            updateItem(item.id, {
                              demonstrationProvided: checked === true,
                            })
                          }
                        />
                        Demonstrated
                      </label>
                    )}
                  </div>

                  <Textarea
                    value={draft?.notes ?? ""}
                    onChange={(e) => updateItem(item.id, { notes: e.target.value })}
                    placeholder={item.notesPrompt ?? "Notes (optional)"}
                    className="mt-2 min-h-[36px] text-sm"
                    rows={1}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="space-y-3 rounded-md border bg-muted/30 p-4">
        <Label htmlFor="signoff-comments" className="text-sm font-medium">
          Comments (optional)
        </Label>
        <Textarea
          id="signoff-comments"
          value={comments}
          onChange={(e) => setComments(e.target.value)}
          placeholder="Any notes about this induction"
          rows={2}
        />
        <label className="flex items-start gap-3 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={declarationAccepted}
            onCheckedChange={(checked) => setDeclarationAccepted(checked === true)}
          />
          <span>{declaration}</span>
        </label>
        <div className="flex gap-2">
          <Button onClick={handleSubmit} disabled={submitting || !declarationAccepted}>
            {submitting ? "Signing off…" : "Sign off induction"}
          </Button>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
