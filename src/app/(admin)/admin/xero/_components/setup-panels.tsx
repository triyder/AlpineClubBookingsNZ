"use client"

import { useCallback, useEffect, useState } from "react"
import { useConfirm } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { loadAdminXeroContactGroups } from "@/lib/admin-xero-contact-groups"
import { fetchJson, postJson } from "./api"
import { SectionCard, type ToggleSection } from "./shared"
import type { ContactGroup, DuplicateGroup, DuplicateResult, GroupMapping, SyncResult } from "./types"

export function SetupPanels({
  connected,
  open,
  onToggle,
  clubName,
  bookingsName,
  syncing,
  setSyncing,
  setSyncResult,
  onMessage,
  onRefreshOperations,
  onRefreshDiagnostics,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  clubName: string
  bookingsName: string
  syncing: string | null
  setSyncing: (syncing: string | null) => void
  setSyncResult: (result: SyncResult | null) => void
  onMessage: (message: string) => void
  onRefreshOperations: () => void
  onRefreshDiagnostics: () => void
}) {
  const { confirm, confirmDialog } = useConfirm()
  const [contactGroups, setContactGroups] = useState<ContactGroup[]>([])
  const [groupMappings, setGroupMappings] = useState<GroupMapping[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [refreshingGroups, setRefreshingGroups] = useState(false)
  const [sendInvites, setSendInvites] = useState(false)
  const [repairMissingContactCache, setRepairMissingContactCache] = useState(false)
  const [repairingXeroLinks, setRepairingXeroLinks] = useState(false)
  const [duplicates, setDuplicates] = useState<DuplicateResult | null>(null)
  const [scanningDuplicates, setScanningDuplicates] = useState(false)
  const [creatingFamilyGroup, setCreatingFamilyGroup] = useState<string | null>(null)
  const [error, setError] = useState("")

  const loadContactGroups = useCallback(
    async (options?: {
      refreshFromXero?: boolean
      fallbackToRefreshIfEmpty?: boolean
      repairMissingContactCache?: boolean
    }) => {
      if (options?.refreshFromXero) setRefreshingGroups(true)
      else setLoadingGroups(true)
      setError("")
      try {
        const result = await loadAdminXeroContactGroups({
          refreshFromXero: options?.refreshFromXero,
          fallbackToRefreshIfEmpty: options?.fallbackToRefreshIfEmpty,
          repairMissingContactCache: options?.repairMissingContactCache,
        })
        setContactGroups(result.groups)
        setGroupMappings((prev) =>
          result.groups.map((group) => {
            const existing = prev.find((mapping) => mapping.groupId === group.id)
            return {
              groupId: group.id,
              groupName: group.name,
              ageTier: existing?.ageTier ?? "SKIP",
            }
          })
        )
        onRefreshDiagnostics()
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load Xero contact groups")
      } finally {
        setLoadingGroups(false)
        setRefreshingGroups(false)
      }
    },
    [onRefreshDiagnostics]
  )

  useEffect(() => {
    if (connected && open && contactGroups.length === 0 && !loadingGroups && !refreshingGroups) void loadContactGroups()
  }, [connected, contactGroups.length, loadContactGroups, loadingGroups, open, refreshingGroups])

  useEffect(() => {
    if (!connected) {
      setContactGroups([])
      setGroupMappings([])
      setDuplicates(null)
    }
  }, [connected])

  const importMembers = async () => {
    const selectedMappings = groupMappings.filter((mapping) => mapping.ageTier !== "SKIP")
    if (selectedMappings.length === 0) {
      setError("Please select at least one group to import")
      return
    }
    const groupNames = selectedMappings.map((mapping) => mapping.groupName).join(", ")
    const confirmed = await confirm({
      title: `Import members from ${selectedMappings.length} group(s)?`,
      description: `${groupNames}. ${sendInvites ? "Invite emails will be sent to all new members." : "No invite emails will be sent."}`,
      confirmLabel: "Import",
    })
    if (!confirmed) return
    setSyncing("import")
    setSyncResult(null)
    setError("")
    try {
      const data = await postJson<SyncResult>(
        "/api/admin/xero/import-members",
        { groupMappings: selectedMappings, sendInvites, repairMissingContactCache },
        "Import failed"
      )
      setSyncResult(data)
      onRefreshDiagnostics()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Member import failed")
    } finally {
      setSyncing(null)
    }
  }

  const repairXeroLinks = async () => {
    setRepairingXeroLinks(true)
    setError("")
    onMessage("")
    try {
      const data = await postJson<{ message?: string }>("/api/admin/xero/link-maintenance", undefined, "Failed to repair Xero link ledger")
      onMessage(data.message || "Xero link ledger maintenance completed.")
      onRefreshDiagnostics()
      onRefreshOperations()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to repair Xero link ledger")
    } finally {
      setRepairingXeroLinks(false)
    }
  }

  const scanDuplicates = async () => {
    setScanningDuplicates(true)
    setDuplicates(null)
    setError("")
    try {
      setDuplicates(await fetchJson<DuplicateResult>("/api/admin/xero/duplicate-contacts", undefined, "Duplicate scan failed"))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Duplicate scan failed")
    } finally {
      setScanningDuplicates(false)
    }
  }

  const createFamilyGroup = async (group: DuplicateGroup) => {
    const name = group.suggestedGroupName || `Family (${group.email})`
    setCreatingFamilyGroup(group.email)
    setError("")
    try {
      await postJson<{ id?: string }>("/api/admin/family-groups", { name, memberIds: group.eligibleMemberIds }, "Failed to create family group")
      setDuplicates((prev) =>
        prev
          ? {
              ...prev,
              duplicateGroups: prev.duplicateGroups.filter((duplicateGroup) => duplicateGroup.email !== group.email),
              filteredByFamilyGroup: prev.filteredByFamilyGroup + 1,
            }
          : prev
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create family group")
    } finally {
      setCreatingFamilyGroup(null)
    }
  }

  const updateGroupMapping = (groupId: string, ageTier: GroupMapping["ageTier"]) => {
    setGroupMappings((prev) => prev.map((mapping) => (mapping.groupId === groupId ? { ...mapping, ageTier } : mapping)))
  }

  return (
    <SectionCard
      id="xero-section-setup"
      title="Setup Tools"
      description="One-off import and duplicate cleanup tools used during Xero setup or remediation."
      open={open}
      onToggle={(nextOpen) => onToggle("setup", nextOpen)}
    >
      <div className="space-y-6">
        {confirmDialog}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Import Members from Xero</h3>
            <p className="text-sm text-muted-foreground">Import members from Xero contact groups into {bookingsName} and map each group to an age tier.</p>
          </div>
          {contactGroups.length === 0 ? (
            <Button onClick={() => void loadContactGroups({ fallbackToRefreshIfEmpty: true, repairMissingContactCache: true })} disabled={loadingGroups}>
              {loadingGroups ? "Loading Groups..." : "Load Contact Groups"}
            </Button>
          ) : (
            <>
              <div className="flex justify-end">
                <Button variant="outline" onClick={() => void loadContactGroups({ refreshFromXero: true, repairMissingContactCache: true })} disabled={refreshingGroups}>
                  {refreshingGroups ? "Refreshing Groups..." : "Refresh Contact Groups from Xero"}
                </Button>
              </div>
              <div className="space-y-3">
                {contactGroups.map((group) => {
                  const mapping = groupMappings.find((candidate) => candidate.groupId === group.id)
                  return (
                    <div key={group.id} className="flex items-center gap-4 rounded-md border p-3">
                      <div className="flex-1">
                        <p className="text-sm font-medium">{group.name}</p>
                        <p className="text-xs text-muted-foreground">{group.contactCount} contact{group.contactCount !== 1 ? "s" : ""}</p>
                      </div>
                      <div className="w-40">
                        <Select value={mapping?.ageTier || "SKIP"} onValueChange={(value) => updateGroupMapping(group.id, value as GroupMapping["ageTier"])}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="SKIP">Skip</SelectItem>
                            <SelectItem value="INFANT">Infant</SelectItem>
                            <SelectItem value="CHILD">Child</SelectItem>
                            <SelectItem value="YOUTH">Youth</SelectItem>
                            <SelectItem value="ADULT">Adult</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="flex items-center gap-2">
                <input id="sendInvites" type="checkbox" checked={sendInvites} onChange={(event) => setSendInvites(event.target.checked)} className="h-4 w-4 rounded border-gray-300" />
                <Label htmlFor="sendInvites" className="text-sm">Send invite emails to new members (password reset link, valid 7 days)</Label>
              </div>
              <div className="flex items-center gap-2">
                <input id="repairMissingContactCache" type="checkbox" checked={repairMissingContactCache} onChange={(event) => setRepairMissingContactCache(event.target.checked)} className="h-4 w-4 rounded border-gray-300" />
                <Label htmlFor="repairMissingContactCache" className="text-sm">Repair missing contact snapshots during import</Label>
              </div>
              <div className="flex gap-2">
                <Button onClick={() => void importMembers()} disabled={syncing !== null || groupMappings.every((mapping) => mapping.ageTier === "SKIP")}>
                  {syncing === "import" ? "Importing..." : "Import Members"}
                </Button>
                <Button variant="outline" onClick={() => { setContactGroups([]); setGroupMappings([]) }}>Reset</Button>
              </div>
            </>
          )}
        </div>
        <Separator />
        <div className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Xero Link Ledger Repair</h3>
            <p className="text-sm text-muted-foreground">Backfill missing canonical links and deactivate stale duplicate links that no longer match local records.</p>
          </div>
          <Button onClick={() => void repairXeroLinks()} disabled={repairingXeroLinks}>{repairingXeroLinks ? "Repairing..." : "Repair Canonical Links"}</Button>
        </div>
        <Separator />
        <DuplicateGroupsPanel
          clubName={clubName}
          duplicates={duplicates}
          scanning={scanningDuplicates}
          syncing={syncing}
          creatingFamilyGroup={creatingFamilyGroup}
          onScan={scanDuplicates}
          onCreate={createFamilyGroup}
        />
      </div>
    </SectionCard>
  )
}

function DuplicateGroupsPanel({
  clubName,
  duplicates,
  scanning,
  syncing,
  creatingFamilyGroup,
  onScan,
  onCreate,
}: {
  clubName: string
  duplicates: DuplicateResult | null
  scanning: boolean
  syncing: string | null
  creatingFamilyGroup: string | null
  onScan: () => Promise<void>
  onCreate: (group: DuplicateGroup) => Promise<void>
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Duplicates &amp; Family Groups</h3>
        <p className="text-sm text-muted-foreground">Scan Xero contacts for duplicate email addresses and create family groups where appropriate.</p>
      </div>
      <Button onClick={() => void onScan()} disabled={scanning || syncing !== null}>{scanning ? "Scanning..." : "Scan for Duplicates & Family Groups"}</Button>
      {duplicates ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <span className="text-muted-foreground">Total contacts scanned: <span className="font-medium text-foreground">{duplicates.totalContacts}</span></span>
            <span className="text-muted-foreground">Duplicate emails found: <span className="font-medium text-foreground">{duplicates.totalDuplicateEmails}</span></span>
            {duplicates.filteredByFamilyGroup > 0 ? <span className="text-muted-foreground">Already in family groups (hidden): <span className="font-medium text-foreground">{duplicates.filteredByFamilyGroup}</span></span> : null}
          </div>
          {duplicates.duplicateGroups.length === 0 ? (
            <p className="text-sm text-green-700">No duplicate contacts found.</p>
          ) : (
            <div className="space-y-3">
              {duplicates.duplicateGroups.map((group) => (
                <div key={group.email} className="space-y-2 rounded-md border p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium">
                      {group.email}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">({group.contacts.length} contacts)</span>
                      {group.suggestedGroupName ? <span className="ml-2 text-xs font-normal text-blue-600">- {group.suggestedGroupName}</span> : null}
                    </p>
                    {group.canCreateFamilyGroup ? (
                      <Button size="sm" variant="outline" onClick={() => void onCreate(group)} disabled={creatingFamilyGroup === group.email}>
                        {creatingFamilyGroup === group.email ? "Creating..." : "Create Family Group"}
                      </Button>
                    ) : null}
                  </div>
                  <div className="space-y-1">
                    {group.contacts.map((contact) => (
                      <div key={contact.contactID} className="flex items-center gap-3 border-l-2 border-muted py-1 pl-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{contact.name}</span>
                          {contact.memberId ? <Badge variant="outline" className="ml-2 border-green-300 text-xs text-green-700">{clubName} member</Badge> : null}
                          {contact.invoiceCount > 0 ? <Badge variant="default" className="ml-2 bg-blue-600 text-xs">{contact.invoiceCount} invoice{contact.invoiceCount === 1 ? "" : "s"}</Badge> : <Badge variant="secondary" className="ml-2 text-xs">No invoices</Badge>}
                          <span className="ml-2 text-xs text-muted-foreground">{contact.contactStatus}</span>
                        </div>
                        <a href={contact.xeroLink} target="_blank" rel="noopener noreferrer" className="whitespace-nowrap text-xs text-blue-600 hover:underline">Open in Xero</a>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {group.canCreateFamilyGroup
                      ? `These contacts match ${clubName} members. Create a family group to link them, or merge them in Xero.`
                      : "Merge into the contact with invoices. Open each in Xero, then use Xero's merge option from the contact with no invoices."}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
