"use client";

import { useEffect, useState } from "react";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";

type InstructionDocument = {
  key: "OPEN" | "CLOSE" | "DAY_TO_DAY";
  title: string;
  description: string;
  contentHtml: string;
  updatedAt: string | null;
};

// Dark-theme typography for the sanitised instruction HTML on the kiosk.
const KIOSK_HTML_CLASSES =
  "text-base leading-7 text-kiosk-fg [&_a]:text-kiosk-accent [&_a]:underline [&_h1]:mt-3 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mt-3 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold [&_hr]:my-3 [&_hr]:border-kiosk-border [&_li]:my-1 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_table]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-kiosk-border [&_td]:p-2 [&_th]:border [&_th]:border-kiosk-border [&_th]:bg-kiosk-inset [&_th]:p-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6";

/**
 * Collapsible lodge-instructions section for the kiosk. Rendered only for
 * the admin/hut-leader tiers; the API enforces the same rule server-side.
 */
export function KioskLodgeInstructions({ date }: { date: string }) {
  const [expanded, setExpanded] = useState(false);
  const [openKey, setOpenKey] = useState<InstructionDocument["key"] | null>(
    null,
  );
  const [documents, setDocuments] = useState<InstructionDocument[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  // Fetch the documents the first time the section is expanded.
  useEffect(() => {
    if (!expanded || documents !== null) {
      return;
    }

    let cancelled = false;
    fetch(`/api/lodge/instructions?date=${date}`, {
      credentials: "same-origin",
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError("Failed to load the lodge instructions.");
          return;
        }
        const body = (await res.json()) as {
          documents: InstructionDocument[];
        };
        if (!cancelled) {
          setDocuments(body.documents);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("Failed to load the lodge instructions.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [expanded, documents, date]);

  return (
    <section className="bg-kiosk-card rounded-2xl p-4 mb-4 border border-kiosk-border">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center justify-between gap-3 text-left min-h-[44px]"
      >
        <span className="flex items-center gap-2 text-lg font-semibold text-kiosk-fg">
          <BookOpen className="h-5 w-5 text-kiosk-accent" />
          Lodge Instructions
        </span>
        {expanded ? (
          <ChevronUp className="h-5 w-5 text-kiosk-muted-fg" />
        ) : (
          <ChevronDown className="h-5 w-5 text-kiosk-muted-fg" />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {error && <p className="text-sm text-kiosk-danger-fg">{error}</p>}
          {!error && documents === null && (
            <p className="text-sm text-kiosk-muted-fg">Loading instructions...</p>
          )}
          {documents?.map((doc) => (
            <div
              key={doc.key}
              className="rounded-xl bg-kiosk-inset border border-kiosk-border"
            >
              <button
                type="button"
                onClick={() =>
                  setOpenKey((current) => (current === doc.key ? null : doc.key))
                }
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left min-h-[48px]"
              >
                <span className="text-base font-medium text-kiosk-fg">
                  {doc.title}
                </span>
                {openKey === doc.key ? (
                  <ChevronUp className="h-4 w-4 text-kiosk-muted-fg" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-kiosk-muted-fg" />
                )}
              </button>
              {openKey === doc.key && (
                <div className="border-t border-kiosk-border px-4 py-3">
                  {doc.contentHtml ? (
                    // contentHtml is sanitised on write and again on read
                    // by the API before it reaches the kiosk.
                    <div
                      className={KIOSK_HTML_CLASSES}
                      dangerouslySetInnerHTML={{ __html: doc.contentHtml }}
                    />
                  ) : (
                    <p className="text-sm text-kiosk-muted-fg">
                      No instructions have been written for this section yet.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
