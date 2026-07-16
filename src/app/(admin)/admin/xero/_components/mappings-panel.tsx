"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback"
import { fetchJson } from "./api"
import {
  ACCOUNT_MAPPING_KEYS,
  CREDIT_ITEM_MAPPING_KEYS,
  formatReferenceCacheLabel,
  MAPPING_DESCRIPTIONS,
  MAPPING_LABELS,
  MAPPING_TYPE_FILTER,
  SectionCard,
  type ToggleSection,
} from "./shared"
import type {
  AccountMappingKey,
  AccountMappings,
  CreditItemMappingKey,
  EntranceFeeMap,
  HutFeeMap,
  XeroAccount,
  XeroItem,
  XeroReferenceCacheMeta,
} from "./types"

type AccountsResponse = { accounts?: XeroAccount[]; cache?: XeroReferenceCacheMeta | null }
type ItemsResponse = { items?: XeroItem[]; cache?: XeroReferenceCacheMeta | null }
type ItemCodeResponse = { hutFees?: HutFeeMap; entranceFees?: EntranceFeeMap }

export function MappingsPanel({
  connected,
  open,
  onToggle,
  clubName,
}: {
  connected: boolean
  open: boolean
  onToggle: ToggleSection
  clubName: string
}) {
  const [accountMappings, setAccountMappings] = useState<AccountMappings | null>(null)
  const [savedMappings, setSavedMappings] = useState<AccountMappings | null>(null)
  const [chartOfAccounts, setChartOfAccounts] = useState<XeroAccount[]>([])
  const [xeroItems, setXeroItems] = useState<XeroItem[]>([])
  const [accountCacheMeta, setAccountCacheMeta] = useState<XeroReferenceCacheMeta | null>(null)
  const [itemCacheMeta, setItemCacheMeta] = useState<XeroReferenceCacheMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshingReferenceData, setRefreshingReferenceData] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [saved, setSaved] = useState(false)
  const [isEditingMappings, setEditing] = useState(false)
  const [hutFeeItemCodes, setHutFeeItemCodes] = useState<HutFeeMap>({})
  const [savedHutFeeItemCodes, setSavedHutFeeItemCodes] = useState<HutFeeMap>({})
  const [entranceFeeItemCodes, setEntranceFeeItemCodes] = useState<EntranceFeeMap>({})
  const [savedEntranceFeeItemCodes, setSavedEntranceFeeItemCodes] = useState<EntranceFeeMap>({})
  const panelRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLParagraphElement>(null)
  const { scrollToError, scrollToTop } = useScrollToFeedback()

  const fetchMappings = useCallback(async (options?: { forceRefresh?: boolean }) => {
    setLoading(true)
    setError("")
    try {
      const refreshSuffix = options?.forceRefresh ? "?refresh=1" : ""
      const [mappings, accounts, items, itemCodes] = await Promise.all([
        fetchJson<AccountMappings>("/api/admin/xero/account-mappings", undefined, "Failed to load account mappings"),
        fetchJson<AccountsResponse>(`/api/admin/xero/chart-of-accounts${refreshSuffix}`, undefined, "Failed to load Xero accounts"),
        fetchJson<ItemsResponse>(`/api/admin/xero/items${refreshSuffix}`, undefined, "Failed to load Xero items"),
        fetchJson<ItemCodeResponse>("/api/admin/xero/item-code-mappings", undefined, "Failed to load item code mappings"),
      ])
      setAccountMappings(mappings)
      setSavedMappings(mappings)
      setChartOfAccounts(accounts.accounts ?? [])
      setAccountCacheMeta(accounts.cache ?? null)
      setXeroItems(items.items ?? [])
      setItemCacheMeta(items.cache ?? null)
      setHutFeeItemCodes(itemCodes.hutFees ?? {})
      setSavedHutFeeItemCodes(itemCodes.hutFees ?? {})
      setEntranceFeeItemCodes(itemCodes.entranceFees ?? {})
      setSavedEntranceFeeItemCodes(itemCodes.entranceFees ?? {})
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load account mappings")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (connected && open && !accountMappings && !loading) void fetchMappings()
  }, [accountMappings, connected, fetchMappings, loading, open])

  useEffect(() => {
    if (error) scrollToError(errorRef)
  }, [error, scrollToError])

  useEffect(() => {
    if (saved) scrollToTop(panelRef)
  }, [saved, scrollToTop])

  const refreshReferenceData = async () => {
    setRefreshingReferenceData(true)
    try {
      await fetchMappings({ forceRefresh: true })
    } finally {
      setRefreshingReferenceData(false)
    }
  }

  const saveMappings = async () => {
    if (!accountMappings) return
    setSaving(true)
    setError("")
    setSaved(false)
    try {
      const savedAccounts = await fetchJson<AccountMappings>(
        "/api/admin/xero/account-mappings",
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(accountMappings) },
        "Failed to save mappings"
      )
      const savedItemCodes = await fetchJson<ItemCodeResponse>(
        "/api/admin/xero/item-code-mappings",
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hutFees: hutFeeItemCodes, entranceFees: entranceFeeItemCodes }) },
        "Failed to save item code mappings"
      )
      setAccountMappings(savedAccounts)
      setSavedMappings(savedAccounts)
      setHutFeeItemCodes(savedItemCodes.hutFees ?? {})
      setSavedHutFeeItemCodes(savedItemCodes.hutFees ?? {})
      setEntranceFeeItemCodes(savedItemCodes.entranceFees ?? {})
      setSavedEntranceFeeItemCodes(savedItemCodes.entranceFees ?? {})
      setEditing(false)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save mappings")
    } finally {
      setSaving(false)
    }
  }

  const cancelEditing = () => {
    setAccountMappings(savedMappings)
    setHutFeeItemCodes(savedHutFeeItemCodes)
    setEntranceFeeItemCodes(savedEntranceFeeItemCodes)
    setEditing(false)
    setError("")
  }

  return (
    <SectionCard
      id="xero-section-mappings"
      title="Account Mappings"
      description={`Map ${clubName} booking transactions to Xero accounts and items.`}
      open={open}
      onToggle={(nextOpen) => onToggle("mappings", nextOpen)}
    >
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading accounts...</p>
      ) : (
        <div ref={panelRef} className="space-y-4">
          {error ? (
            <p
              ref={errorRef}
              role="alert"
              tabIndex={-1}
              className="scroll-mt-20 text-sm text-danger focus:outline-none"
            >
              {error}
            </p>
          ) : null}
          {saved ? <p className="text-sm text-success">Account mappings saved.</p> : null}
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
            <div className="space-y-1">
              <p>{formatReferenceCacheLabel("Accounts", accountCacheMeta)}</p>
              <p>{formatReferenceCacheLabel("Items", itemCacheMeta)}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void refreshReferenceData()} disabled={loading || refreshingReferenceData}>
              {refreshingReferenceData ? "Refreshing..." : "Refresh Xero reference data"}
            </Button>
          </div>
          <h4 className="text-sm font-semibold text-foreground">Account Code Mappings</h4>
          {accountMappings ? ACCOUNT_MAPPING_KEYS.map((key) => (
            <AccountMappingRow
              key={key}
              mappingKey={key}
              mappings={accountMappings}
              setMappings={setAccountMappings}
              accounts={chartOfAccounts}
              isEditingMappings={isEditingMappings}
            />
          )) : null}
          <Separator />
          <h4 className="text-sm font-semibold text-foreground">Credit Note Item Codes</h4>
          <p className="text-xs text-muted-foreground">Xero Items for credit note line items. When set, Xero can apply the item configuration while the mapped account remains available for reporting.</p>
          {accountMappings ? CREDIT_ITEM_MAPPING_KEYS.map((key) => (
            <CreditItemRow key={key} mappingKey={key} mappings={accountMappings} setMappings={setAccountMappings} items={xeroItems} isEditingMappings={isEditingMappings} />
          )) : null}
          <Separator />
          <HutFeeTable isEditingMappings={isEditingMappings} items={xeroItems} codes={hutFeeItemCodes} setCodes={setHutFeeItemCodes} />
          <Separator />
          <EntranceFeeTable isEditingMappings={isEditingMappings} items={xeroItems} codes={entranceFeeItemCodes} setCodes={setEntranceFeeItemCodes} />
          <div className="flex gap-2 pt-2">
            {isEditingMappings ? (
              <>
                <Button onClick={() => void saveMappings()} disabled={saving || !accountMappings}>{saving ? "Saving..." : "Save Changes"}</Button>
                <Button variant="outline" onClick={cancelEditing} disabled={saving}>Cancel</Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setEditing(true)}>Edit Mappings</Button>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  )
}

function AccountMappingRow({
  mappingKey,
  mappings,
  setMappings,
  accounts,
  isEditingMappings,
}: {
  mappingKey: AccountMappingKey
  mappings: AccountMappings
  setMappings: (value: AccountMappings | null | ((prev: AccountMappings | null) => AccountMappings | null)) => void
  accounts: XeroAccount[]
  isEditingMappings: boolean
}) {
  const typeFilter = MAPPING_TYPE_FILTER[mappingKey]
  const filtered = accounts.filter((account) => account.type === typeFilter)
  const currentCode = mappings[mappingKey]?.code
  const matchedAccount = filtered.find((account) => account.code === currentCode)
  return (
    <div className="grid grid-cols-3 items-start gap-4">
      <div>
        <p className="text-sm font-medium">{MAPPING_LABELS[mappingKey]}</p>
        <p className="text-xs text-muted-foreground">{MAPPING_DESCRIPTIONS[mappingKey]}</p>
      </div>
      <div className="col-span-2">
        {isEditingMappings ? (
          <Select value={currentCode ?? "__none__"} onValueChange={(value) => setMappings((prev) => prev ? { ...prev, [mappingKey]: { ...prev[mappingKey], code: value === "__none__" ? null : value } } : prev)}>
            <SelectTrigger><SelectValue placeholder="Select account..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__"><span className="text-muted-foreground">Not configured (use default)</span></SelectItem>
              {filtered.map((account) => <SelectItem key={account.code} value={account.code}>{account.code} - {account.name}</SelectItem>)}
              {filtered.length === 0 ? <SelectItem value="__empty__" disabled>No {typeFilter.toLowerCase()} accounts found</SelectItem> : null}
            </SelectContent>
          </Select>
        ) : (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{matchedAccount ? `${matchedAccount.code} - ${matchedAccount.name}` : currentCode || <span className="text-muted-foreground">Not configured (using default)</span>}</p>
        )}
      </div>
    </div>
  )
}

function CreditItemRow({
  mappingKey,
  mappings,
  setMappings,
  items,
  isEditingMappings,
}: {
  mappingKey: CreditItemMappingKey
  mappings: AccountMappings
  setMappings: (value: AccountMappings | null | ((prev: AccountMappings | null) => AccountMappings | null)) => void
  items: XeroItem[]
  isEditingMappings: boolean
}) {
  const currentItemCode = mappings[mappingKey]?.itemCode
  const matchedItem = items.find((item) => item.code === currentItemCode)
  return (
    <div className="grid grid-cols-3 items-start gap-4">
      <div>
        <p className="text-sm font-medium">{MAPPING_LABELS[mappingKey]}</p>
        <p className="text-xs text-muted-foreground">{MAPPING_DESCRIPTIONS[mappingKey]}</p>
      </div>
      <div className="col-span-2">
        {isEditingMappings ? (
          <Select value={currentItemCode ?? "__none__"} onValueChange={(value) => setMappings((prev) => prev ? { ...prev, [mappingKey]: { ...prev[mappingKey], itemCode: value === "__none__" ? null : value } } : prev)}>
            <SelectTrigger><SelectValue placeholder="Select item..." /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__"><span className="text-muted-foreground">Not configured</span></SelectItem>
              {items.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} - {item.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{matchedItem ? `${matchedItem.code} - ${matchedItem.name}` : currentItemCode || <span className="text-muted-foreground">Not configured</span>}</p>
        )}
      </div>
    </div>
  )
}

function HutFeeTable({ isEditingMappings, items, codes, setCodes }: { isEditingMappings: boolean; items: XeroItem[]; codes: HutFeeMap; setCodes: (value: HutFeeMap | ((prev: HutFeeMap) => HutFeeMap)) => void }) {
  return (
    <>
      <h4 className="text-sm font-semibold text-foreground">Hut Fee Item Codes</h4>
      <p className="text-xs text-muted-foreground">Map each combination of age tier, season, and membership status to a Xero Item.</p>
      {isEditingMappings ? (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => {
            if (items.length === 0) return
            const filled: HutFeeMap = {}
            for (const tier of ["INFANT", "CHILD", "YOUTH", "ADULT"]) for (const season of ["WINTER", "SUMMER"]) for (const member of [true, false]) filled[`${tier}_${season}_${member}`] = { itemCode: items[0].code }
            setCodes(filled)
          }}>Copy first item to all</Button>
          <Button variant="outline" size="sm" onClick={() => setCodes({})}>Clear all</Button>
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead><tr>{["Age Tier", "Winter / Member", "Winter / Non-Member", "Summer / Member", "Summer / Non-Member"].map((heading) => <th key={heading} className="border-b p-2 text-left font-medium text-muted-foreground">{heading}</th>)}</tr></thead>
          <tbody>
            {(["ADULT", "YOUTH", "CHILD", "INFANT"] as const).map((tier) => (
              <tr key={tier} className="border-b last:border-0">
                <td className="p-2 font-medium text-foreground">{tier}</td>
                {(["WINTER_true", "WINTER_false", "SUMMER_true", "SUMMER_false"] as const).map((combo) => {
                  const mapKey = `${tier}_${combo}`
                  const currentCode = codes[mapKey]?.itemCode ?? null
                  const matchedItem = items.find((item) => item.code === currentCode)
                  return (
                    <td key={combo} className="p-2">
                      {isEditingMappings ? <ItemSelect currentCode={currentCode} items={items} onChange={(value) => setCodes((prev) => updateHutFeeMap(prev, mapKey, value))} /> : <span className={currentCode ? "text-foreground" : "text-muted-foreground"}>{matchedItem?.code ?? currentCode ?? "Not set"}</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

function EntranceFeeTable({ isEditingMappings, items, codes, setCodes }: { isEditingMappings: boolean; items: XeroItem[]; codes: EntranceFeeMap; setCodes: (value: EntranceFeeMap | ((prev: EntranceFeeMap) => EntranceFeeMap)) => void }) {
  return (
    <>
      <h4 className="text-sm font-semibold text-foreground">Joining Fee Categories</h4>
      <p className="text-xs text-muted-foreground">Configure joining fee amounts and Xero Item codes per membership category.</p>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead><tr>{["Category", "Xero Item", "Amount (incl. GST)"].map((heading) => <th key={heading} className="border-b p-2 text-left font-medium text-muted-foreground">{heading}</th>)}</tr></thead>
          <tbody>
            {([{ key: "ADULT", label: "Adult" }, { key: "YOUTH", label: "Youth" }, { key: "CHILD", label: "Child" }, { key: "FAMILY", label: "Family" }] as const).map(({ key, label }) => {
              const entry = codes[key]
              const currentCode = entry?.itemCode ?? null
              const currentAmountCents = entry?.amountCents ?? null
              const matchedItem = items.find((item) => item.code === currentCode)
              return (
                <tr key={key} className="border-b last:border-0">
                  <td className="p-2 font-medium text-foreground">{label}</td>
                  <td className="p-2">{isEditingMappings ? <ItemSelect currentCode={currentCode} items={items} onChange={(value) => setCodes((prev) => updateEntranceItem(prev, key, value))} /> : <span className={currentCode ? "text-foreground" : "text-muted-foreground"}>{matchedItem ? matchedItem.code : currentCode || "Not set"}</span>}</td>
                  <td className="p-2">
                    {isEditingMappings ? (
                      <div className="flex items-center gap-1">
                        <span className="text-sm">$</span>
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="0.00"
                          value={currentAmountCents != null && currentAmountCents > 0 ? (currentAmountCents / 100).toFixed(2) : ""}
                          onChange={(event) => setCodes((prev) => updateEntranceAmount(prev, key, event.target.value))}
                          className="w-24"
                        />
                      </div>
                    ) : (
                      <span className={currentAmountCents ? "text-foreground" : "text-muted-foreground"}>{currentAmountCents ? `$${(currentAmountCents / 100).toFixed(2)}` : "Not set"}</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}

function ItemSelect({ currentCode, items, onChange }: { currentCode: string | null; items: XeroItem[]; onChange: (value: string) => void }) {
  return (
    <Select value={currentCode ?? "__none__"} onValueChange={onChange}>
      <SelectTrigger className="w-full min-w-[140px]"><SelectValue placeholder="Not set" /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__none__"><span className="text-muted-foreground">Not set</span></SelectItem>
        {items.map((item) => <SelectItem key={item.code} value={item.code}>{item.code} - {item.name}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

function updateHutFeeMap(prev: HutFeeMap, mapKey: string, value: string): HutFeeMap {
  const next = { ...prev }
  if (value === "__none__") delete next[mapKey]
  else next[mapKey] = { itemCode: value }
  return next
}

function updateEntranceItem(prev: EntranceFeeMap, key: string, value: string): EntranceFeeMap {
  const next = { ...prev }
  if (value === "__none__") {
    if (next[key]) next[key] = { ...next[key], itemCode: null }
  } else {
    next[key] = { itemCode: value, amountCents: next[key]?.amountCents ?? null }
  }
  return next
}

function updateEntranceAmount(prev: EntranceFeeMap, key: string, value: string): EntranceFeeMap {
  const dollars = Number.parseFloat(value)
  const cents = Number.isNaN(dollars) || dollars <= 0 ? null : Math.round(dollars * 100)
  return { ...prev, [key]: { itemCode: prev[key]?.itemCode ?? null, amountCents: cents } }
}
