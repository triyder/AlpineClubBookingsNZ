"use client"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useLodgeOptions } from "@/components/lodge-select"

const CLUB_WIDE = "__club_wide__"

// Scope selector for the booking-policy editors (ADR-001 resolved question
// 3): policies are club-wide by default with per-lodge override sets that
// REPLACE (never merge with) the club-wide rules. Unlike LodgeSelect, the
// default option here is explicitly "club-wide", not a lodge. Renders
// nothing while fewer than two lodges exist (ADR-002 presentation rule), so
// single-lodge clubs only ever edit the club-wide rules.
export function PolicyScopeSelect({
  value,
  onChange,
  id = "policy-scope-select",
}: {
  value: string | null
  onChange: (lodgeId: string | null) => void
  id?: string
}) {
  const { lodges, loading } = useLodgeOptions("admin")

  if (loading || lodges.length < 2) {
    return null
  }

  return (
    <div className="max-w-xs space-y-2">
      <Label htmlFor={id}>Rules for</Label>
      <Select
        value={value ?? CLUB_WIDE}
        onValueChange={(next) => onChange(next === CLUB_WIDE ? null : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CLUB_WIDE}>Club-wide rules (default)</SelectItem>
          {lodges.map((lodge) => (
            <SelectItem key={lodge.id} value={lodge.id}>
              {lodge.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function usePolicyScopeLodgeName(lodgeId: string | null): string | null {
  const { lodges } = useLodgeOptions("admin")
  if (!lodgeId) return null
  return lodges.find((lodge) => lodge.id === lodgeId)?.name ?? null
}
