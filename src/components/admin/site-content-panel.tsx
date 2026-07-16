"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  WysiwygEditor,
  type WysiwygEditorHandle,
} from "@/components/admin/page-content-panel";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

// Mirrors SITE_CONTENT_KEYS (src/lib/page-content.ts) and
// SITE_CONTENT_LABELS (src/lib/site-content.ts, server-only).
const SECTIONS = [
  {
    key: "FOOTER_BLURB",
    title: "Footer: club blurb",
    description:
      "Short paragraph under the club logo in the footer's first column. " +
      "Leave a section empty to hide that footer column.",
  },
  {
    key: "FOOTER_QUICK_LINKS",
    title: "Footer: quick links",
    description:
      "Heading and link list in the footer's middle column. " +
      "Leave a section empty to hide that footer column.",
  },
  {
    key: "FOOTER_AFFILIATIONS",
    title: "Footer: affiliations",
    description:
      "Heading and link list in the footer's last column. " +
      "Leave a section empty to hide that footer column.",
  },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

type ApiDocument = {
  key: SectionKey;
  contentHtml: string;
  updatedAt: string | null;
};

function formatUpdatedAt(value: string | null): string {
  if (!value) {
    return "Never updated";
  }
  return new Date(value).toLocaleString("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function SiteContentPanel() {
  const canEdit = useAdminAreaEditAccess("content");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Defense-in-depth: a 403 from a stale tab (editors still shown) surfaces a
  // visible, persistent error rather than only an ephemeral toast (#1927).
  const [forbidden, setForbidden] = useState(false);
  const [drafts, setDrafts] = useState<Record<SectionKey, string>>({
    FOOTER_BLURB: "",
    FOOTER_QUICK_LINKS: "",
    FOOTER_AFFILIATIONS: "",
  });
  const [updatedAt, setUpdatedAt] = useState<Record<SectionKey, string | null>>(
    {
      FOOTER_BLURB: null,
      FOOTER_QUICK_LINKS: null,
      FOOTER_AFFILIATIONS: null,
    },
  );
  const [savingKey, setSavingKey] = useState<SectionKey | null>(null);
  const editorRefs = useRef<Record<SectionKey, WysiwygEditorHandle | null>>({
    FOOTER_BLURB: null,
    FOOTER_QUICK_LINKS: null,
    FOOTER_AFFILIATIONS: null,
  });

  // Load all sections for editing.
  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/admin/site-content", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error("load-failed");
      }
      const body = (await res.json()) as { documents: ApiDocument[] };
      const nextDrafts = {
        FOOTER_BLURB: "",
        FOOTER_QUICK_LINKS: "",
        FOOTER_AFFILIATIONS: "",
      } as Record<SectionKey, string>;
      const nextUpdatedAt = {
        FOOTER_BLURB: null,
        FOOTER_QUICK_LINKS: null,
        FOOTER_AFFILIATIONS: null,
      } as Record<SectionKey, string | null>;
      for (const doc of body.documents) {
        nextDrafts[doc.key] = doc.contentHtml;
        nextUpdatedAt[doc.key] = doc.updatedAt;
      }
      setDrafts(nextDrafts);
      setUpdatedAt(nextUpdatedAt);
    } catch {
      setLoadError("Failed to load site content. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  // Save a single section; content is sanitised again server-side.
  async function saveDocument(key: SectionKey, title: string) {
    const contentHtml = editorRefs.current[key]?.getHtml() ?? drafts[key];
    setSavingKey(key);
    setForbidden(false);
    try {
      const res = await fetch("/api/admin/site-content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ key, contentHtml }),
      });
      if (!res.ok) {
        if (res.status === 403) {
          setForbidden(true);
        }
        const body = await res.json().catch(() => null);
        toast.error(body?.error ?? `Failed to save ${title}`);
        return;
      }
      const body = (await res.json()) as { document: ApiDocument };
      setDrafts((prev) => ({ ...prev, [key]: body.document.contentHtml }));
      setUpdatedAt((prev) => ({ ...prev, [key]: body.document.updatedAt }));
      toast.success(`${title} saved`);
    } catch {
      toast.error(`Failed to save ${title}`);
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) {
    return <p className="text-sm text-slate-500">Loading site content...</p>;
  }

  if (loadError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-red-600">{loadError}</p>
        <Button type="button" variant="outline" onClick={loadDocuments}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!canEdit ? (
        <AdminViewOnlyNotice>
          Your admin role can view site content but cannot change it. The
          editors below are read-only.
        </AdminViewOnlyNotice>
      ) : null}
      {forbidden ? <AdminForbiddenSaveNotice /> : null}
      {SECTIONS.map((section) => (
        <Card key={section.key}>
          <CardHeader>
            <CardTitle>{section.title}</CardTitle>
            <CardDescription>
              {section.description} Last saved:{" "}
              {formatUpdatedAt(updatedAt[section.key])}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Text tokens ({{facebook-url}} etc.) resolve on the public
                footer; the token help button lists what's available. */}
            <WysiwygEditor
              ref={(handle) => {
                editorRefs.current[section.key] = handle;
              }}
              value={drafts[section.key]}
              onChange={(html) =>
                setDrafts((prev) => ({ ...prev, [section.key]: html }))
              }
              placeholder={`Write the ${section.title.toLowerCase()} content...`}
              tokenHelpContext="site-footer"
              readOnly={!canEdit}
            />
            <div className="flex justify-end">
              <ViewOnlyActionButton
                canEdit={canEdit}
                type="button"
                onClick={() => saveDocument(section.key, section.title)}
                disabled={savingKey !== null}
              >
                <Save className="mr-2 h-4 w-4" />
                {savingKey === section.key
                  ? "Saving..."
                  : `Save ${section.title}`}
              </ViewOnlyActionButton>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
