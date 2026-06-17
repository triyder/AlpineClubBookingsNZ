"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  type InductionDetailClient,
  type SelfAssessmentLevel,
  SELF_ASSESSMENT_LABELS,
} from "@/lib/induction-display";

const LEVELS: SelfAssessmentLevel[] = ["UNDERSTAND", "CAN_DO", "CAN_TEACH"];

function buildInitialDraft(
  detail: InductionDetailClient
): Record<string, SelfAssessmentLevel | null> {
  const draft: Record<string, SelfAssessmentLevel | null> = {};
  for (const section of detail.template.sections) {
    for (const item of section.items) {
      draft[item.id] = detail.selfAssessment?.[item.id] ?? null;
    }
  }
  return draft;
}

export function InductionSelfAssessForm({
  induction,
  onSaved,
}: {
  induction: InductionDetailClient;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, SelfAssessmentLevel | null>>(
    () => buildInitialDraft(induction)
  );
  const [submitting, setSubmitting] = useState(false);

  function setLevel(itemId: string, level: SelfAssessmentLevel | null) {
    setDraft((prev) => ({ ...prev, [itemId]: level }));
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await fetch(`/api/inductions/${induction.id}/self-assess`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: draft }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Failed to save your self-assessment.");
        return;
      }
      toast.success("Your self-assessment has been saved.");
      onSaved();
    } catch {
      toast.error("Failed to save your self-assessment.");
    } finally {
      setSubmitting(false);
    }
  }

  const totalItems = induction.template.sections.reduce(
    (n, s) => n + s.items.length,
    0
  );
  const assessedItems = Object.values(draft).filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        Work through each item below and mark your level of familiarity. Your
        responses are visible to your assigned signers when they sign off.
        <span className="ml-2 font-medium text-foreground">
          {assessedItems}/{totalItems} items marked.
        </span>
      </div>

      {induction.template.sections.map((section) => (
        <div key={section.id} className="space-y-2">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {section.title}
          </h4>
          {section.description && (
            <p className="text-xs text-muted-foreground">{section.description}</p>
          )}
          <ul className="space-y-2">
            {section.items.map((item) => {
              const current = draft[item.id] ?? null;
              return (
                <li key={item.id} className="rounded-md border p-3">
                  <p className="text-sm font-medium">
                    {item.label}
                    {item.isMandatory && (
                      <span className="ml-2 text-xs font-normal text-destructive">
                        Mandatory
                      </span>
                    )}
                  </p>
                  {item.competencyPrompt && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.competencyPrompt}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {LEVELS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() =>
                          setLevel(item.id, current === level ? null : level)
                        }
                        className={cn(
                          "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                          current === level
                            ? "border-primary bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-accent"
                        )}
                      >
                        {SELF_ASSESSMENT_LABELS[level]}
                      </button>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <Button onClick={handleSubmit} disabled={submitting}>
        {submitting ? "Saving…" : "Save my self-assessment"}
      </Button>
    </div>
  );
}
