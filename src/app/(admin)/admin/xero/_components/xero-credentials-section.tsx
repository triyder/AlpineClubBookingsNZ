"use client"

import { useRef } from "react"
import { useSession } from "next-auth/react"
import { KeyRound } from "lucide-react"

import { isFullAdmin } from "@/lib/access-roles"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback"

/**
 * INTERIM in-app entry for the Xero OAuth credentials (#2079, C1).
 *
 * DB-only credentials mean a C1-only deployment has no other way to (re)enter
 * Xero client id/secret/webhook key — the DEPLOYMENT.md upgrade runbook points
 * here. This is deliberately minimal: the C2 wizard (#2080) REPLACES this
 * section with the full guided flow, so keep it small and do not grow it.
 *
 * Contract:
 *  - Full Admin only writes (mirrors requireFullAdminForConfigTransfer /
 *    config-transfer page gating); other admins see a view-only banner and
 *    read-only status.
 *  - Values are WRITE-ONLY and never round-trip: the display state comes from a
 *    metadata-only GET (set/not-set + set-at + secretSource — never a value or
 *    ciphertext), and Save re-seeds from the fresh server METADATA, never from
 *    the typed inputs.
 *  - Verify-reset (epic decision 6): writing client id/secret drops the stored
 *    OAuth tokens, so the operator must reconnect — surfaced after save.
 */

const ENDPOINT = "/api/admin/integrations/credentials"
const PROVIDER = "xero"

// Keys mirror XERO_CREDENTIAL_KEYS in src/lib/xero-config.ts. Writing either of
// the two RESET keys drops the OAuth tokens (verify-reset), so the operator
// reconnects after entering them.
const RESET_KEYS = ["client_id", "client_secret"] as const

const FIELDS = [
  {
    key: "client_id",
    label: "Client ID",
    type: "text" as const,
    placeholder: "Xero app client ID",
    helper: "From your Xero developer app. Replacing it clears the connection.",
  },
  {
    key: "client_secret",
    label: "Client Secret",
    type: "password" as const,
    placeholder: "Xero app client secret",
    helper: "Write-only. Replacing it clears the connection.",
  },
  {
    key: "webhook_key",
    label: "Webhook Signing Key",
    type: "password" as const,
    placeholder: "Optional — for Xero webhooks",
    helper: "Optional. Required only if you use Xero webhooks.",
  },
]

interface FieldMeta {
  set: boolean
  setAt: string | null
  secretSource: string | null
}

interface CredDraft {
  // Ephemeral write-only inputs (never seeded from the server).
  inputs: Record<string, string>
  // Display-only metadata from the metadata GET.
  meta: Record<string, FieldMeta>
}

const EMPTY_INPUTS: Record<string, string> = {
  client_id: "",
  client_secret: "",
  webhook_key: "",
}

type MetadataResponse = {
  credentials?: Record<
    string,
    { set?: boolean; setAt?: string; secretSource?: string }
  >
}

function toMeta(data: MetadataResponse): Record<string, FieldMeta> {
  const credentials = data.credentials ?? {}
  const meta: Record<string, FieldMeta> = {}
  for (const field of FIELDS) {
    const row = credentials[field.key]
    meta[field.key] = {
      set: Boolean(row?.set),
      setAt: row?.setAt ?? null,
      secretSource: row?.secretSource ?? null,
    }
  }
  return meta
}

async function fetchMetadata(signal?: AbortSignal): Promise<CredDraft> {
  const res = await fetch(`${ENDPOINT}?provider=${PROVIDER}`, { signal })
  if (!res.ok) throw new Error("Failed to load Xero credential status")
  return { inputs: { ...EMPTY_INPUTS }, meta: toMeta(await res.json()) }
}

function formatSetAt(setAt: string | null): string {
  if (!setAt) return ""
  const date = new Date(setAt)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("en-NZ", {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
}

export function XeroCredentialsSection() {
  const { data: session } = useSession()
  // Tri-state: undefined while the session resolves (neutral), then Full-Admin.
  const canEdit: boolean | undefined = session
    ? isFullAdmin({ accessRoles: session.user?.accessRoles ?? [] })
    : undefined

  // Whether the last successful save touched a reset key (verify-reset note).
  const didResetRef = useRef(false)

  const section = useSectionEditState<CredDraft>({
    initial: { inputs: { ...EMPTY_INPUTS }, meta: toMeta({}) },
    load: (signal) => fetchMetadata(signal),
    // Dirty when any write-only input has content — the metadata is display-only.
    isDirty: (draft) => FIELDS.some((f) => draft.inputs[f.key]?.trim()),
    // Save only when at least one field carries a value to write.
    isValid: (draft) => FIELDS.some((f) => Boolean(draft.inputs[f.key]?.trim())),
    save: async (draft) => {
      const toWrite = FIELDS.filter((f) => draft.inputs[f.key]?.trim())
      didResetRef.current = toWrite.some((f) =>
        (RESET_KEYS as readonly string[]).includes(f.key),
      )
      // Write each provided value (one row per POST). The first failure aborts
      // and surfaces its plain-English message (e.g. the weak-secret gate).
      for (const field of toWrite) {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: PROVIDER,
            key: field.key,
            value: draft.inputs[field.key].trim(),
          }),
        })
        if (!res.ok) {
          if (res.status === 403) throw new ForbiddenSaveError()
          const data = (await res.json().catch(() => null)) as {
            error?: string
          } | null
          throw new Error(data?.error || `Failed to save ${field.label}.`)
        }
      }
      // Re-seed from the fresh server METADATA (not the typed inputs); inputs
      // are cleared so no value ever survives in component state.
      return fetchMetadata()
    },
    successMessage: () =>
      didResetRef.current
        ? "Xero credentials saved. The Xero connection was reset — reconnect Xero below to re-authorise."
        : "Xero credentials saved.",
    saveErrorFallback: "Failed to save Xero credentials.",
    loadErrorFallback: "Failed to load Xero credential status.",
  })

  const { draft, editing, saving, dirty, valid, error, success } = section

  // Frame rendered in EVERY state (banner + feedback), only the cards below swap
  // — the live-region position rule (AGENTS.md / #2142).
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      Your admin role can view Xero credential status, but only a Full Admin can
      change credentials.
    </AdminViewOnlySectionBanner>
  )
  const feedback = (
    <PolicyFeedback
      error={error}
      success={success}
      onClearError={() => section.setError("")}
      onClearSuccess={() => section.setSuccess("")}
    />
  )

  if (section.loading || !draft) {
    return (
      <div>
        {viewOnlyBanner}
        {feedback}
        {section.loading ? (
          <div className="py-6 text-center text-muted-foreground">Loading…</div>
        ) : null}
      </div>
    )
  }

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card className="mb-6">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              Xero Credentials
            </CardTitle>
            <CardDescription>
              Client ID, secret, and (optional) webhook key. Stored encrypted;
              values are never displayed. Replacing the client ID or secret
              clears the connection and requires reconnecting.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {FIELDS.map((field) => {
            const meta = draft.meta[field.key]
            return (
              <div key={field.key} className="space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`xero-cred-${field.key}`}>{field.label}</Label>
                  <span className="text-xs text-muted-foreground">
                    {meta?.set ? (
                      <span className="text-emerald-700">
                        Set ✓{formatSetAt(meta.setAt) ? ` ${formatSetAt(meta.setAt)}` : ""}
                      </span>
                    ) : (
                      "Not set"
                    )}
                  </span>
                </div>
                {editing ? (
                  <Input
                    id={`xero-cred-${field.key}`}
                    type={field.type}
                    autoComplete="off"
                    placeholder={
                      meta?.set ? "Enter a new value to replace" : field.placeholder
                    }
                    value={draft.inputs[field.key] ?? ""}
                    onChange={(e) =>
                      section.setDraft((current) => ({
                        ...current,
                        inputs: { ...current.inputs, [field.key]: e.target.value },
                      }))
                    }
                  />
                ) : null}
                <p className="text-xs text-muted-foreground">{field.helper}</p>
              </div>
            )
          })}

          {editing && (
            <div className="flex gap-3">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void section.save()}
                disabled={!dirty || !valid || saving}
              >
                {saving ? "Saving…" : "Save credentials"}
              </ViewOnlyActionButton>
              <Button
                variant="outline"
                onClick={section.cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Interim entry form. The Xero setup wizard will replace this section.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
