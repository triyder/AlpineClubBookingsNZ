"use client";

import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Code,
  ImageIcon,
  Palette,
  RotateCcw,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OccupancyMeter } from "@/components/ui/occupancy-meter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CLUB_THEME_COLOUR_FIELDS,
  CLUB_THEME_FONT_OPTIONS,
  DEFAULT_CLUB_THEME_VALUES,
  MAX_LOGO_DATA_URL_BYTES,
  buildClubThemeCss,
  fontCssVariable,
  fontLabel,
  getBlockingContrastWarnings,
  getContrastWarnings,
  isValidLogoDataUrl,
  type ClubThemeColourKey,
  type ClubThemeFontKey,
  type ClubThemeValues,
  type ContrastWarning,
} from "@/lib/club-theme-schema";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  AdminForbiddenSaveNotice,
  AdminViewOnlyNotice,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

// Type-only reference to the lazy-loaded zod schema. `typeof import(...)` in a
// type position emits no runtime import, so naming the schema's type here never
// pulls zod into the admin/site-style client bundle (#1278).
type ClubThemeUpdateSchema =
  typeof import("@/lib/club-theme-update-schema")["clubThemeUpdateSchema"];

type SiteStyleThemeResponse = ClubThemeValues & {
  completedAt: string | null;
  contrastWarnings: ContrastWarning[];
};

type SiteStyleWizardProps = {
  initialTheme: SiteStyleThemeResponse;
};

const steps = [
  { id: "colours", label: "Colours", icon: Palette },
  { id: "fonts", label: "Fonts", icon: Type },
  { id: "raw-css", label: "Raw CSS", icon: Code },
  { id: "logo", label: "Logo", icon: ImageIcon },
  { id: "review", label: "Review", icon: CheckCircle2 },
] as const;

type StepId = (typeof steps)[number]["id"];

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function themePayload(values: ClubThemeValues, completeSetup: boolean) {
  return {
    ...values,
    completeSetup,
  };
}

function previewStyle(values: ClubThemeValues): CSSProperties {
  return {
    "--brand-gold": values.brandGold,
    "--brand-charcoal": values.brandCharcoal,
    "--brand-deep": values.brandDeep,
    "--brand-ridge": values.brandRidge,
    "--brand-mist": values.brandMist,
    "--brand-snow": values.brandSnow,
    "--brand-safety": values.brandSafety,
    "--font-website-heading": `var(${fontCssVariable(values.headingFontKey)})`,
    "--font-website-body": `var(${fontCssVariable(values.bodyFontKey)})`,
  } as CSSProperties;
}

export function SiteStyleWizard({ initialTheme }: SiteStyleWizardProps) {
  const router = useRouter();
  const canEdit = useAdminAreaEditAccess("content");
  const [forbidden, setForbidden] = useState(false);
  const [values, setValues] = useState<ClubThemeValues>({
    brandGold: initialTheme.brandGold,
    brandCharcoal: initialTheme.brandCharcoal,
    brandDeep: initialTheme.brandDeep,
    brandRidge: initialTheme.brandRidge,
    brandMist: initialTheme.brandMist,
    brandSnow: initialTheme.brandSnow,
    brandSafety: initialTheme.brandSafety,
    headingFontKey: initialTheme.headingFontKey,
    bodyFontKey: initialTheme.bodyFontKey,
    logoDataUrl: initialTheme.logoDataUrl,
    rawCss: initialTheme.rawCss ?? "",
  });
  const [completedAt, setCompletedAt] = useState(initialTheme.completedAt);
  const [step, setStep] = useState<StepId>("colours");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const stepIndex = steps.findIndex((item) => item.id === step);
  // Live inline field validation uses the zod update schema, which is code-split
  // out of this route's initial bundle and lazy-loaded on mount (#1278,
  // follow-up from #1197). Until it resolves, inline field errors stay empty;
  // the synchronous contrast gate below and the server-side validation on save
  // still guard the payload, so degrading gracefully here is safe.
  const [updateSchema, setUpdateSchema] =
    useState<ClubThemeUpdateSchema | null>(null);
  const [fieldErrors, setFieldErrors] = useState<
    Record<string, string[] | undefined>
  >({});

  useEffect(() => {
    let active = true;
    void import("@/lib/club-theme-update-schema").then((module) => {
      if (active) {
        setUpdateSchema(module.clubThemeUpdateSchema);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!updateSchema) {
      setFieldErrors({});
      return;
    }
    const parsed = updateSchema.safeParse(themePayload(values, false));
    setFieldErrors(parsed.success ? {} : parsed.error.flatten().fieldErrors);
  }, [updateSchema, values]);
  const contrastWarnings = useMemo(() => getContrastWarnings(values), [values]);
  // Measurable AA failures block saving (mirrors the server gate in the
  // site-style route); both hex and oklch values are measured.
  const blockingContrastWarnings = useMemo(
    () => getBlockingContrastWarnings(values),
    [values],
  );
  const advisoryContrastWarnings = useMemo(
    () => contrastWarnings.filter((warning) => warning.ratio === null),
    [contrastWarnings],
  );
  const cssPreview = useMemo(() => buildClubThemeCss(values), [values]);

  function updateColour(key: ClubThemeColourKey, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedMessage("");
  }

  function updateFont(
    key: "headingFontKey" | "bodyFontKey",
    value: ClubThemeFontKey,
  ) {
    setValues((current) => ({ ...current, [key]: value }));
    setSavedMessage("");
  }

  function updateRawCss(value: string) {
    setValues((current) => ({ ...current, rawCss: value }));
    setSavedMessage("");
  }

  async function save(completeSetup: boolean) {
    setSaving(true);
    setError("");
    setSavedMessage("");
    setForbidden(false);

    try {
      const response = await fetch("/api/admin/site-style", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(themePayload(values, completeSetup)),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.theme) {
        if (response.status === 403) setForbidden(true);
        throw new Error(
          responseErrorMessage(body, "Failed to save site style"),
        );
      }

      const theme = body.theme as SiteStyleThemeResponse;
      setValues({
        brandGold: theme.brandGold,
        brandCharcoal: theme.brandCharcoal,
        brandDeep: theme.brandDeep,
        brandRidge: theme.brandRidge,
        brandMist: theme.brandMist,
        brandSnow: theme.brandSnow,
        brandSafety: theme.brandSafety,
        headingFontKey: theme.headingFontKey,
        bodyFontKey: theme.bodyFontKey,
        logoDataUrl: theme.logoDataUrl,
        rawCss: theme.rawCss ?? "",
      });
      setCompletedAt(theme.completedAt);
      setSavedMessage(
        completeSetup ? "Site style is complete." : "Site style saved.",
      );
      router.refresh();
      return true;
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to save site style",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function goNext() {
    const saved = await save(false);
    if (saved && stepIndex < steps.length - 1) {
      setStep(steps[stepIndex + 1].id);
    }
  }

  async function finish() {
    const saved = await save(true);
    if (saved) {
      setStep("review");
    }
  }

  function resetNeutral() {
    setValues(DEFAULT_CLUB_THEME_VALUES);
    setCompletedAt(null);
    setSavedMessage("");
    setError("");
  }

  function readLogo(file: File) {
    setError("");
    if (file.size > MAX_LOGO_DATA_URL_BYTES) {
      setError("Logo must be 900KB or smaller.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!isValidLogoDataUrl(dataUrl)) {
        setError("Logo must be a PNG, JPEG, WebP, or GIF image data URL.");
        return;
      }
      setValues((current) => ({ ...current, logoDataUrl: dataUrl }));
      setSavedMessage("");
    };
    reader.onerror = () => setError("Logo could not be read.");
    reader.readAsDataURL(file);
  }

  const activeStep = steps[stepIndex];
  const ActiveStepIcon = activeStep.icon;
  const hasFieldErrors = Object.values(fieldErrors).some(
    (messages) => messages && messages.length > 0,
  );
  const saveBlocked = hasFieldErrors || blockingContrastWarnings.length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Style Setup Wizard</CardTitle>
            <CardDescription>
              {completedAt
                ? "The public website, member area, and admin area are using this style."
                : "The member and admin areas use this style immediately; the public website stays on the setup holding page until setup is finished."}
            </CardDescription>
          </div>
          <Badge variant={completedAt ? "success" : "warning"}>
            {completedAt ? "Complete" : "Setup required"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {!canEdit ? (
          <AdminViewOnlyNotice>
            Your admin role can view the site style but cannot change it. The
            controls below are read-only.
          </AdminViewOnlyNotice>
        ) : null}
        {forbidden ? <AdminForbiddenSaveNotice /> : null}
        <div className="grid gap-2 sm:grid-cols-5">
          {steps.map((item) => {
            const Icon = item.icon;
            const active = item.id === step;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setStep(item.id)}
                className={`flex min-h-11 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  active
                    ? "border-brand-gold bg-brand-gold text-brand-charcoal"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </button>
            );
          })}
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
          <section className="space-y-5">
            <div className="flex items-center gap-2">
              <ActiveStepIcon className="h-5 w-5 text-foreground" />
              <h2 className="text-lg font-semibold text-foreground">
                {activeStep.label}
              </h2>
            </div>

            {step === "colours" && (
              <div className="space-y-5">
                <div className="rounded-md border bg-muted p-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Editable brand layer</p>
                  <p className="mt-1">
                    These colours set the identity, neutral warmth, primary actions,
                    navigation, and occupancy meter across the public website,
                    member area, and admin area. The primary accent is glacial teal
                    by default and may be club gold or another accessible brand colour.
                  </p>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {CLUB_THEME_COLOUR_FIELDS.map((field) => (
                    <div key={field.key} className="space-y-2">
                      <Label htmlFor={field.key}>{field.label}</Label>
                      <div className="flex gap-2">
                        <Input
                          id={field.key}
                          type="color"
                          value={
                            values[field.key].startsWith("#")
                              ? values[field.key]
                              : DEFAULT_CLUB_THEME_VALUES[field.key]
                          }
                          onChange={(event) =>
                            updateColour(field.key, event.target.value)
                          }
                          className="h-10 w-14 shrink-0 p-1"
                          aria-label={`${field.label} swatch`}
                          disabled={!canEdit}
                        />
                        <Input
                          value={values[field.key]}
                          onChange={(event) =>
                            updateColour(field.key, event.target.value)
                          }
                          aria-label={`${field.label} value`}
                          readOnly={!canEdit}
                        />
                      </div>
                      {fieldErrors[field.key]?.[0] && (
                        <p className="text-sm text-red-700">
                          {fieldErrors[field.key]?.[0]}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                <div className="rounded-md border p-4 text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">Fixed semantic layer</p>
                  <p className="mt-1">
                    Success, warning, information, danger/error, and waitlist states
                    use curated light/dark colour pairs. They are not brand pickers,
                    so operational meaning and contrast stay consistent.
                  </p>
                </div>
              </div>
            )}

            {step === "fonts" && (
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Heading font</Label>
                  <Select
                    value={values.headingFontKey}
                    disabled={!canEdit}
                    onValueChange={(value) =>
                      updateFont("headingFontKey", value as ClubThemeFontKey)
                    }
                  >
                    <SelectTrigger aria-label="Heading font">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CLUB_THEME_FONT_OPTIONS.map((font) => (
                        <SelectItem key={font.key} value={font.key}>
                          {font.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Body font</Label>
                  <Select
                    value={values.bodyFontKey}
                    disabled={!canEdit}
                    onValueChange={(value) =>
                      updateFont("bodyFontKey", value as ClubThemeFontKey)
                    }
                  >
                    <SelectTrigger aria-label="Body font">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CLUB_THEME_FONT_OPTIONS.map((font) => (
                        <SelectItem key={font.key} value={font.key}>
                          {font.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {step === "raw-css" && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Add custom CSS rules that will be appended to the generated
                  theme stylesheet on the public website only. Member and admin
                  areas receive the validated brand variables above, never raw
                  CSS. Use sparingly — prefer colour and font settings where
                  possible.
                </p>
                <textarea
                  value={values.rawCss}
                  onChange={(e) => updateRawCss(e.target.value)}
                  rows={16}
                  spellCheck={false}
                  readOnly={!canEdit}
                  placeholder={`/* Example */\n.dynamic-header {\n  background: linear-gradient(135deg, #1a1a2e, #16213e);\n}`}
                  className="w-full rounded-md border border-slate-300 bg-white p-3 font-mono text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-400"
                />
                {values.rawCss.length > 45_000 && (
                  <p className="text-sm text-amber-700">
                    {values.rawCss.length.toLocaleString()} / 50,000 characters
                    used.
                  </p>
                )}
              </div>
            )}

            {step === "logo" && (
              <div className="space-y-4">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      readLogo(file);
                    }
                    event.target.value = "";
                  }}
                />
                <div className="flex flex-wrap gap-3">
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    type="button"
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="mr-2 h-4 w-4" />
                    Choose logo
                  </ViewOnlyActionButton>
                  {values.logoDataUrl && (
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setValues((current) => ({
                          ...current,
                          logoDataUrl: null,
                        }));
                        setSavedMessage("");
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Remove logo
                    </ViewOnlyActionButton>
                  )}
                </div>
                {fieldErrors.logoDataUrl?.[0] && (
                  <p className="text-sm text-red-700">
                    {fieldErrors.logoDataUrl?.[0]}
                  </p>
                )}
              </div>
            )}

            {step === "review" && (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md border p-4">
                    <p className="text-sm font-medium text-foreground">Fonts</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      Heading: {fontLabel(values.headingFontKey)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Body: {fontLabel(values.bodyFontKey)}
                    </p>
                  </div>
                  <div className="rounded-md border p-4">
                    <p className="text-sm font-medium text-foreground">Logo</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {values.logoDataUrl
                        ? "Custom logo stored"
                        : "Club name fallback"}
                    </p>
                  </div>
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">
                    Generated CSS
                  </p>
                  <pre className="max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                    {cssPreview}
                  </pre>
                </div>
                {values.rawCss && (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">
                      Raw CSS
                    </p>
                    <pre className="max-h-40 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">
                      {values.rawCss}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </section>

          <aside className="space-y-4">
            <div
              className="website-theme overflow-hidden rounded-md border border-brand-ridge/25 bg-brand-snow text-brand-deep"
              style={previewStyle(values)}
            >
              <div className="bg-brand-charcoal px-5 py-4 text-brand-snow">
                <div className="flex items-center gap-3">
                  {values.logoDataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={values.logoDataUrl}
                      alt="Logo preview"
                      className="h-10 max-w-36 object-contain"
                    />
                  ) : (
                    <span className="font-heading text-lg font-bold">
                      Club Name
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-4 p-5">
                <p className="website-eyebrow">Preview</p>
                <h3 className="font-heading text-2xl font-bold text-brand-charcoal">
                  Public website heading
                </h3>
                <p className="text-sm leading-6 text-brand-deep/85">
                  This sample uses the selected colours and font variables.
                </p>
                <button
                  type="button"
                  className="rounded-md bg-brand-gold px-4 py-2 text-sm font-semibold text-brand-charcoal"
                >
                  Primary action
                </button>
              </div>
            </div>

            <div
              className="app-theme-scope space-y-4 overflow-hidden rounded-md border bg-background p-5 text-foreground"
              style={previewStyle(values)}
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Member + admin app preview
                </p>
                <h3 className="mt-1 text-2xl font-bold">Upcoming lodge stay</h3>
              </div>
              <OccupancyMeter filled={18} capacity={30} label="Occupancy" />
              <button
                type="button"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                Primary action
              </button>
              <div className="flex flex-wrap gap-2 text-xs font-medium">
                <span className="rounded-md bg-success-muted px-2 py-1 text-success">Success</span>
                <span className="rounded-md bg-warning-muted px-2 py-1 text-warning">Warning</span>
                <span className="rounded-md bg-info-muted px-2 py-1 text-info">Information</span>
                <span className="rounded-md bg-danger-muted px-2 py-1 text-danger">Danger</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Brand colours and fonts update this app preview. Status colours stay fixed.
              </p>
            </div>

            {blockingContrastWarnings.length > 0 && (
              <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Contrast too low to save
                </div>
                <p className="mb-2">
                  Saving is disabled until these text pairs meet the WCAG AA
                  4.5:1 minimum. Lighten or darken the colours below and the
                  warning clears automatically.
                </p>
                <ul className="space-y-1">
                  {blockingContrastWarnings.map((warning) => (
                    <li key={warning.id}>{warning.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {advisoryContrastWarnings.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Contrast warnings
                </div>
                <ul className="space-y-1">
                  {advisoryContrastWarnings.map((warning) => (
                    <li key={warning.id}>{warning.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
                {error}
              </div>
            )}
            {savedMessage && (
              <div className="rounded-md border border-green-300 bg-green-50 p-4 text-sm text-green-800">
                {savedMessage}
              </div>
            )}
          </aside>
        </div>

        <div className="flex flex-wrap justify-between gap-3 border-t pt-5">
          <ViewOnlyActionButton
            canEdit={canEdit}
            type="button"
            variant="outline"
            onClick={resetNeutral}
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset neutral
          </ViewOnlyActionButton>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(steps[Math.max(0, stepIndex - 1)].id)}
              disabled={stepIndex === 0 || saving}
            >
              Back
            </Button>
            {stepIndex < steps.length - 1 ? (
              <ViewOnlyActionButton
                canEdit={canEdit}
                type="button"
                onClick={goNext}
                disabled={saving || saveBlocked}
              >
                {saving ? "Saving..." : "Save and next"}
              </ViewOnlyActionButton>
            ) : (
              <ViewOnlyActionButton
                canEdit={canEdit}
                type="button"
                onClick={finish}
                disabled={saving || saveBlocked}
              >
                {saving ? "Saving..." : "Finish setup"}
              </ViewOnlyActionButton>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
