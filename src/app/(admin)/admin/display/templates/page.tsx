"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackLink } from "@/components/admin/back-link";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { listDisplayCssTokens } from "@/lib/lodge-display/css-tokens";
import { listDisplayModules } from "@/lib/lodge-display/module-registry";
import { isBuiltInDisplayTemplateKey } from "@/lib/lodge-display/built-in-seeds";
import {
  buildSlots,
  buildSlotContentPayload,
  reseedSlotFromDefault,
  type AreaDefinition,
  type OptionDraft,
  type SlotDraft,
} from "./template-slots";

// Lobby display TEMPLATE authoring (fork issue #79, LTV-033, ADR-003 §1). A
// Template is built on a Layout: it fills each declared slot with content or an
// embedded module, layers CSS overrides on the layout default, and carries the
// footer. It renders dynamically against whichever lodge its display is bound
// to — lodge-specific values come from `{{config:…}}` tokens.
//
// Deliberate design notes:
//  • Slot content is authored in plain monospace <textarea>s (HTML mode) or a
//    module dropdown + scalar options (Module mode), NOT the website
//    page-content rich editor. That editor (page-content-panel.tsx) is a
//    heavyweight surface coupled to EditablePageRecord CRUD, uploads, and page
//    save endpoints — not a reusable rich-text field — so wiring it in is out
//    of scope for a v1. Safety does not depend on the editor: all authored HTML
//    is sanitised at serve time (LTV-029) and validated by the shared save
//    contract server-side. This is a noted deviation from the epic brief; the
//    owner can revisit if a reusable rich editor is extracted later.
//  • The Layout binding is chosen once and LOCKED after creation — changing it
//    would orphan slot content authored against the original layout's areas.
//  • Slot boxes are GENERATED from the bound layout's areas (static/conditional
//    → one box keyed by the area; rotator → one box per child keyed
//    "area/child"), each seeded from the layout's defaultContent when present.

interface LayoutOption {
  id: string;
  key: string;
  name: string;
}

interface LodgeOption {
  id: string;
  name: string;
}

interface TemplateDraft {
  /** null → creating; a string → editing that template id. */
  id: string | null;
  key: string;
  name: string;
  layoutId: string;
  layoutName: string;
  slots: SlotDraft[];
  cssOverrides: string;
  footerHtml: string;
}

interface TemplateListItem {
  id: string;
  key: string;
  name: string;
  layout: { id: string; key: string; name: string };
  deviceCount: number;
  updatedAt: string;
}

interface ValidationIssue {
  path: string;
  message: string;
}

function emptyDraft(): TemplateDraft {
  return {
    id: null,
    key: "",
    name: "",
    layoutId: "",
    layoutName: "",
    slots: [],
    cssOverrides: "",
    footerHtml: "",
  };
}

export default function AdminDisplayTemplatesPage() {
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [layouts, setLayouts] = useState<LayoutOption[]>([]);
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [previewLodgeId, setPreviewLodgeId] = useState("");
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [saving, setSaving] = useState(false);
  // Display templates resolve to the "lodge" area, so gate authoring on
  // lodge:edit — a lodge:view admin can open a template and preview it (a
  // view-level action) but every input, and the Save/Delete/Add/Duplicate write
  // controls, stay disabled (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");

  // Closed registries surfaced read-only into the editor (client-safe pure data).
  const modules = useMemo(() => listDisplayModules(), []);
  const cssTokens = useMemo(() => listDisplayCssTokens(), []);

  // A built-in template is code-managed scaffolding: `ensureBuiltInDisplays`
  // refreshes it from code on every re-seed/upgrade (owner decision A, #111), so
  // an in-place edit does not survive. Detected by the reserved KEY (the seed
  // matches on key). Only an EXISTING row can be a built-in. Drives the
  // persistent notice + the not-upgrade-safe save confirm (#156).
  const editingBuiltIn =
    draft.id !== null && isBuiltInDisplayTemplateKey(draft.key);

  const refresh = useCallback(async () => {
    const [templatesRes, layoutsRes, lodgesRes] = await Promise.all([
      fetch("/api/admin/display/templates"),
      fetch("/api/admin/display/layouts"),
      // Same source the Devices page uses: the admin lodges list. When more
      // than one active lodge exists the preview lodge selector appears (a
      // template is lodge-agnostic, so its preview lodge must be chosen).
      fetch("/api/admin/lodges").catch(() => null),
    ]);
    if (templatesRes.ok) {
      const body = (await templatesRes.json()) as { templates: TemplateListItem[] };
      setTemplates(body.templates ?? []);
    }
    if (layoutsRes.ok) {
      const body = (await layoutsRes.json()) as { layouts: LayoutOption[] };
      setLayouts(body.layouts ?? []);
    }
    if (lodgesRes?.ok) {
      const body = (await lodgesRes.json()) as {
        lodges?: Array<{ id: string; name: string; active?: boolean }>;
      };
      const active = (body.lodges ?? []).filter((lodge) => lodge.active !== false);
      setLodges(active.map((lodge) => ({ id: lodge.id, name: lodge.name })));
      setPreviewLodgeId((current) => current || active[0]?.id || "");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function startNew() {
    setDraft(emptyDraft());
    setErrors([]);
    setWarnings([]);
    setMessage(null);
  }

  // Fork the opened built-in into a NEW custom template (id cleared → a create),
  // carrying its layout binding, slots, CSS, and footer but a fresh key/name so
  // the admin customises the copy instead of the upgrade-clobbered original
  // (#156, design.md §3/§8). The built-in itself is untouched until the copy is
  // saved; with the id cleared the layout binding becomes editable again.
  function duplicateTemplate() {
    setErrors([]);
    setWarnings([]);
    setDraft((current) => ({
      ...current,
      id: null,
      key: current.key ? `${current.key}-copy` : "",
      name: current.name ? `${current.name} (copy)` : "",
    }));
    setMessage(
      "Duplicated to a new custom template — adjust the key and name, then " +
        "Create it. The built-in is unchanged."
    );
  }

  // Choosing a layout (create mode only) loads its areas and generates the slot
  // boxes seeded from the layout defaults.
  async function chooseLayout(layoutId: string) {
    if (layoutId === "") {
      setDraft((current) => ({ ...current, layoutId: "", layoutName: "", slots: [] }));
      return;
    }
    const response = await fetch(`/api/admin/display/layouts/${layoutId}`);
    if (!response.ok) {
      setMessage("Could not load that layout");
      return;
    }
    const body = (await response.json()) as {
      layout: { id: string; name: string; areas: unknown };
    };
    const areas = Array.isArray(body.layout.areas)
      ? (body.layout.areas as AreaDefinition[])
      : [];
    setDraft((current) => ({
      ...current,
      layoutId: body.layout.id,
      layoutName: body.layout.name,
      slots: buildSlots(areas),
    }));
  }

  async function editTemplate(id: string) {
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    const response = await fetch(`/api/admin/display/templates/${id}`);
    if (!response.ok) {
      setMessage("Could not load that template");
      return;
    }
    const body = (await response.json()) as {
      template: {
        id: string;
        key: string;
        name: string;
        layout: { id: string; name: string; areas: unknown };
        slotContent: unknown;
        cssOverrides: string;
        footerHtml: string;
      };
    };
    const areas = Array.isArray(body.template.layout.areas)
      ? (body.template.layout.areas as AreaDefinition[])
      : [];
    const slotContent =
      body.template.slotContent &&
      typeof body.template.slotContent === "object" &&
      !Array.isArray(body.template.slotContent)
        ? (body.template.slotContent as Record<string, unknown>)
        : {};
    setDraft({
      id: body.template.id,
      key: body.template.key,
      name: body.template.name,
      layoutId: body.template.layout.id,
      layoutName: body.template.layout.name,
      slots: buildSlots(areas, slotContent),
      cssOverrides: body.template.cssOverrides,
      footerHtml: body.template.footerHtml,
    });
  }

  // Preview opens the sandboxed host page (LTV-036, ADR-003 §5), NOT /display
  // directly: the host mints a signed grant and renders the authored template in
  // an `sandbox="allow-scripts"` iframe, so it can never execute against this
  // admin session. The lodge is passed explicitly so the preview is
  // never a silent default (#64).
  function previewTemplate(item: TemplateListItem) {
    const params = new URLSearchParams({
      templateId: item.id,
      templateName: item.name,
    });
    if (lodges.length > 1 && previewLodgeId) {
      params.set("previewLodge", previewLodgeId);
    }
    window.open(
      `/admin/display/preview?${params.toString()}`,
      "_blank",
      "noopener,noreferrer"
    );
  }

  async function deleteTemplate(item: TemplateListItem) {
    setMessage(null);
    if (
      !window.confirm(
        `Delete template "${item.name}" (${item.key})? This cannot be undone.`
      )
    ) {
      return;
    }
    const response = await fetch(`/api/admin/display/templates/${item.id}`, {
      method: "DELETE",
    });
    if (response.status === 403) {
      setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      return;
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      setMessage(body?.error ?? "Could not delete the template");
      return;
    }
    if (draft.id === item.id) startNew();
    setMessage(`Deleted template "${item.name}".`);
    await refresh();
  }

  async function save() {
    // Saving an in-place edit to a built-in is not upgrade-safe (it is
    // overwritten on the next re-seed/upgrade, #111); require an explicit
    // acknowledgement before persisting (#156).
    if (
      draft.id !== null &&
      isBuiltInDisplayTemplateKey(draft.key) &&
      !window.confirm(
        `"${draft.name || draft.key}" is a built-in template. Saving this ` +
          "in-place edit is NOT upgrade-safe — it will be overwritten the next " +
          "time the built-in designs are re-seeded or the app is upgraded. " +
          "Duplicate it to customise safely instead.\n\nSave the in-place edit anyway?"
      )
    ) {
      return;
    }

    setSaving(true);
    setErrors([]);
    setWarnings([]);
    setMessage(null);

    const payload = {
      key: draft.key.trim(),
      name: draft.name.trim(),
      layoutId: draft.layoutId,
      slotContent: buildSlotContentPayload(draft.slots),
      cssOverrides: draft.cssOverrides,
      footerHtml: draft.footerHtml,
    };

    const editing = draft.id !== null;
    const response = await fetch(
      editing
        ? `/api/admin/display/templates/${draft.id}`
        : "/api/admin/display/templates",
      {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const body = (await response.json().catch(() => null)) as
      | {
          template?: { id: string; key: string; name: string };
          warnings?: ValidationIssue[];
          errors?: ValidationIssue[];
          error?: string;
        }
      | null;

    setSaving(false);

    if (!response.ok) {
      if (response.status === 403) {
        setMessage(ADMIN_FORBIDDEN_SAVE_REASON);
      } else if (body?.errors && body.errors.length > 0) {
        setErrors(body.errors);
        setWarnings(body.warnings ?? []);
      } else {
        setMessage(body?.error ?? "Save failed");
      }
      return;
    }

    setWarnings(body?.warnings ?? []);
    setMessage(
      `Template "${body?.template?.name ?? draft.name}" saved.` +
        (body?.warnings && body.warnings.length > 0
          ? " Some CSS was flagged — see the notices below."
          : "")
    );
    // A create now has an id; keep editing it so a follow-up save is a PUT.
    if (!editing && body?.template) {
      setDraft((current) => ({ ...current, id: body.template!.id }));
    }
    await refresh();
  }

  // --- Slot-row mutation helpers -----------------------------------------
  function updateSlot(index: number, patch: Partial<SlotDraft>) {
    setDraft((current) => ({
      ...current,
      slots: current.slots.map((slot, i) =>
        i === index ? { ...slot, ...patch } : slot
      ),
    }));
  }

  // Re-seed one slot's editor from its layout-provided default (issue #111),
  // reusing the same seeding path buildSlots uses on create. Only offered for
  // slots whose area declares a defaultContent (static/conditional built-ins).
  function resetSlotToDefault(index: number) {
    setDraft((current) => ({
      ...current,
      slots: current.slots.map((slot, i) =>
        i === index ? reseedSlotFromDefault(slot) : slot
      ),
    }));
  }

  function updateOption(slotIndex: number, optionIndex: number, patch: Partial<OptionDraft>) {
    setDraft((current) => ({
      ...current,
      slots: current.slots.map((slot, i) =>
        i === slotIndex
          ? {
              ...slot,
              options: slot.options.map((option, oi) =>
                oi === optionIndex ? { ...option, ...patch } : option
              ),
            }
          : slot
      ),
    }));
  }

  const selectClass =
    "border-input bg-background h-9 rounded-md border px-3 text-sm";
  const textareaClass =
    "border-input bg-background w-full rounded-md border p-3 font-mono text-xs";

  return (
    <div className="space-y-6 p-6">
      <div>
        <BackLink href="/admin/display" label="Lobby Display" />
        <h1 className="mt-2 text-2xl font-bold">Display Templates</h1>
        <p className="text-muted-foreground">
          A Template fills a <strong>Layout</strong>&apos;s slots with content or
          embedded modules, layers CSS overrides on the layout default, and
          carries the footer. Bind a Template to a display on the{" "}
          <strong>Devices</strong> page.
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          Templates render against whichever lodge their display is bound to —
          lodge-specific values come from{" "}
          <code className="bg-muted rounded px-1">{"{{config:…}}"}</code> tokens.
        </p>
      </div>

      {!canEdit ? (
        <AdminViewOnlyNotice>
          Your admin role can view the lobby display templates but cannot change
          them. Lodge edit access is required to author, edit, or delete a
          template. Preview stays available.
        </AdminViewOnlyNotice>
      ) : null}

      {message && <p className="text-sm font-medium">{message}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!loading && templates.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No templates yet. Author one below.
            </p>
          )}
          <div className="space-y-3">
            {templates.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-3 border-b pb-3 last:border-b-0"
              >
                <div className="min-w-64 flex-1">
                  <p className="font-medium">
                    {item.name}{" "}
                    <code className="bg-muted text-muted-foreground ml-1 rounded px-1.5 py-0.5 font-mono text-xs">
                      {item.key}
                    </code>
                  </p>
                  <p className="text-muted-foreground text-sm">
                    Layout: {item.layout.name}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {item.deviceCount === 0
                      ? "No devices use this template"
                      : item.deviceCount === 1
                        ? "1 device uses this template"
                        : `${item.deviceCount} devices use this template`}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {lodges.length > 1 && (
                    <select
                      className={selectClass}
                      aria-label="Preview lodge"
                      title="Lodge to preview this template against"
                      value={previewLodgeId}
                      onChange={(event) => setPreviewLodgeId(event.target.value)}
                    >
                      {lodges.map((lodge) => (
                        <option key={lodge.id} value={lodge.id}>
                          {lodge.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button variant="outline" onClick={() => previewTemplate(item)}>
                    Preview
                  </Button>
                  <Button variant="outline" onClick={() => void editTemplate(item.id)}>
                    Edit
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    variant="destructive"
                    onClick={() => void deleteTemplate(item)}
                  >
                    Delete
                  </ViewOnlyActionButton>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4">
            <Button variant="outline" onClick={startNew}>
              New template
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            {draft.id ? `Edit template — ${draft.name || draft.key}` : "New template"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {editingBuiltIn && (
            <div
              role="note"
              className="space-y-2 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <p className="font-medium">This is a built-in template.</p>
              <p>
                In-place edits to a built-in are{" "}
                <strong>overwritten</strong> the next time the built-in designs
                are re-seeded or the app is upgraded. To keep your changes,
                duplicate this template and customise the copy instead.
              </p>
              <ViewOnlyActionButton
                canEdit={canEdit}
                variant="outline"
                className="h-9"
                onClick={duplicateTemplate}
              >
                Duplicate to customise
              </ViewOnlyActionButton>
            </div>
          )}
          <div className="flex flex-wrap gap-4">
            <div className="space-y-1">
              <Label htmlFor="template-key">Key</Label>
              <Input
                id="template-key"
                className="w-56 font-mono"
                placeholder="foyer-board"
                value={draft.key}
                disabled={draft.id !== null || !canEdit}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, key: event.target.value }))
                }
              />
              <p className="text-muted-foreground text-xs">
                {draft.id
                  ? "Locked — the key is fixed once devices bind to it."
                  : "Lower-case slug. Fixed after creation."}
              </p>
            </div>
            <div className="min-w-64 flex-1 space-y-1">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                placeholder="Foyer board"
                value={draft.name}
                disabled={!canEdit}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="template-layout">Layout</Label>
            {draft.id ? (
              <p className="text-sm">
                <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                  {draft.layoutName}
                </code>{" "}
                <span className="text-muted-foreground">
                  — locked. The layout is fixed after creation; its slots are
                  authored below.
                </span>
              </p>
            ) : (
              <>
                <select
                  id="template-layout"
                  className={selectClass}
                  value={draft.layoutId}
                  disabled={!canEdit}
                  onChange={(event) => void chooseLayout(event.target.value)}
                >
                  <option value="">— select a layout —</option>
                  {layouts.map((layout) => (
                    <option key={layout.id} value={layout.id}>
                      {layout.name}
                    </option>
                  ))}
                </select>
                <p className="text-muted-foreground text-xs">
                  Choose the structural layout to fill. Locked once the template
                  is created.
                </p>
              </>
            )}
          </div>

          {draft.layoutId !== "" && (
            <div className="space-y-3">
              <Label>Slots</Label>
              {draft.slots.length === 0 && (
                <p className="text-muted-foreground text-sm">
                  This layout declares no fillable slots.
                </p>
              )}
              {draft.slots.map((slot, index) => (
                <div key={slot.slotKey} className="space-y-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                          {slot.label}
                        </code>
                      </p>
                      {slot.description && (
                        <p className="text-muted-foreground text-sm">
                          {slot.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {slot.defaultContent !== undefined && (
                        <Button
                          variant="outline"
                          className="h-9"
                          title="Re-seed this slot from the layout's default content"
                          disabled={!canEdit}
                          onClick={() => resetSlotToDefault(index)}
                        >
                          Reset to default
                        </Button>
                      )}
                      <Label className="text-xs" htmlFor={`slot-mode-${index}`}>
                        Mode
                      </Label>
                      <select
                        id={`slot-mode-${index}`}
                        className={selectClass}
                        value={slot.mode}
                        disabled={!canEdit}
                        onChange={(event) =>
                          updateSlot(index, {
                            mode: event.target.value as "html" | "module",
                          })
                        }
                      >
                        <option value="html">HTML</option>
                        <option value="module">Module</option>
                      </select>
                    </div>
                  </div>

                  {slot.mode === "html" ? (
                    <div className="space-y-1">
                      <textarea
                        id={`slot-html-${index}`}
                        className={`${textareaClass} min-h-24`}
                        spellCheck={false}
                        disabled={!canEdit}
                        placeholder={"Empty — HTML goes here, e.g. <p>{{lodge-name}}</p>"}
                        value={slot.html}
                        onChange={(event) =>
                          updateSlot(index, { html: event.target.value })
                        }
                      />
                      <p className="text-muted-foreground text-xs">
                        HTML with tokens:{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{config:key}}"}
                        </code>
                        ,{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{lodge-name}}"}
                        </code>
                        ,{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{display-date}}"}
                        </code>
                        , and a{" "}
                        <code className="bg-muted rounded px-1">
                          {"{{module:name}}"}
                        </code>{" "}
                        embed. Scripts and external URLs are stripped on serve.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <Label className="text-xs" htmlFor={`slot-module-${index}`}>
                          Module
                        </Label>
                        <select
                          id={`slot-module-${index}`}
                          className={selectClass}
                          value={slot.moduleName}
                          disabled={!canEdit}
                          onChange={(event) =>
                            updateSlot(index, { moduleName: event.target.value })
                          }
                        >
                          <option value="">— select a module —</option>
                          {modules.map((module) => (
                            <option
                              key={module.name}
                              value={module.name}
                              title={module.description}
                            >
                              {module.label}
                            </option>
                          ))}
                        </select>
                        {slot.moduleName && (
                          <p className="text-muted-foreground text-xs">
                            {
                              modules.find((m) => m.name === slot.moduleName)
                                ?.description
                            }
                          </p>
                        )}
                      </div>
                      <div className="space-y-2">
                        <Label className="text-xs">Options (scalar key / value)</Label>
                        {slot.options.map((option, optionIndex) => (
                          <div
                            key={optionIndex}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <Input
                              className="w-44 font-mono"
                              placeholder="option-key"
                              value={option.key}
                              disabled={!canEdit}
                              onChange={(event) =>
                                updateOption(index, optionIndex, {
                                  key: event.target.value,
                                })
                              }
                            />
                            <Input
                              className="min-w-40 flex-1"
                              placeholder="value"
                              value={option.value}
                              disabled={!canEdit}
                              onChange={(event) =>
                                updateOption(index, optionIndex, {
                                  value: event.target.value,
                                })
                              }
                            />
                            <Button
                              variant="outline"
                              disabled={!canEdit}
                              onClick={() =>
                                updateSlot(index, {
                                  options: slot.options.filter(
                                    (_, oi) => oi !== optionIndex
                                  ),
                                })
                              }
                            >
                              Remove
                            </Button>
                          </div>
                        ))}
                        <Button
                          variant="outline"
                          disabled={!canEdit}
                          onClick={() =>
                            updateSlot(index, {
                              options: [...slot.options, { key: "", value: "" }],
                            })
                          }
                        >
                          Add option
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="template-css">CSS overrides</Label>
            <textarea
              id="template-css"
              className={`${textareaClass} min-h-24`}
              spellCheck={false}
              disabled={!canEdit}
              placeholder={".board { color: var(--brand-gold); }"}
              value={draft.cssOverrides}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  cssOverrides: event.target.value,
                }))
              }
            />
            <p className="text-muted-foreground text-xs">
              Layered after the layout default. Theme tokens you can reach for:{" "}
              {cssTokens.map((token, i) => (
                <span key={token.name}>
                  {i > 0 && ", "}
                  <code className="bg-muted rounded px-1" title={token.description}>
                    var({token.name})
                  </code>
                </span>
              ))}
              . External URLs, <code>@import</code>, and script vectors are
              stripped automatically on save.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="template-footer">Footer HTML</Label>
            <textarea
              id="template-footer"
              className={`${textareaClass} min-h-20`}
              spellCheck={false}
              disabled={!canEdit}
              placeholder={"Wi-Fi: {{config:wifi-code}} · {{lodge-name}}"}
              value={draft.footerHtml}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  footerHtml: event.target.value,
                }))
              }
            />
            <p className="text-muted-foreground text-xs">
              The page footer. HTML with the same tokens, or a{" "}
              <code className="bg-muted rounded px-1">{"{{module:name}}"}</code>{" "}
              embed.
            </p>
          </div>

          {errors.length > 0 && (
            <div className="border-destructive/40 bg-destructive/10 text-destructive space-y-1 rounded-md border p-3 text-sm">
              <p className="font-medium">This template can&apos;t be saved yet:</p>
              <ul className="list-disc space-y-0.5 pl-5">
                {errors.map((issue, i) => (
                  <li key={i}>
                    <code className="font-mono text-xs">{issue.path}</code> —{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="space-y-1 rounded-md border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-medium">
                Saved, but some CSS was neutralised on the way in:
              </p>
              <ul className="list-disc space-y-0.5 pl-5">
                {warnings.map((issue, i) => (
                  <li key={i}>
                    <code className="font-mono text-xs">{issue.path}</code> —{" "}
                    {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex items-center gap-3">
            <ViewOnlyActionButton
              canEdit={canEdit}
              onClick={() => void save()}
              disabled={saving || !draft.name || !draft.key || draft.layoutId === ""}
            >
              {draft.id ? "Save changes" : "Create template"}
            </ViewOnlyActionButton>
            {draft.id && (
              <Button variant="outline" onClick={startNew} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
