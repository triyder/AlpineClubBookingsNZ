import type { NormalizedCancellationRule } from "@/lib/cancellation-rules"

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export type PolicyRule = NormalizedCancellationRule & { id?: string }

export interface MinStayPolicy {
  id: string
  name: string
  startDate: string
  endDate: string
  triggerDays: number[]
  minimumNights: number
  active: boolean
}

export interface BookingPeriod {
  id: string
  name: string
  startDate: string
  endDate: string
  nonMemberHoldEnabled: boolean
  nonMemberHoldDays: number
  cancellationRules: PolicyRule[]
  active: boolean
}
