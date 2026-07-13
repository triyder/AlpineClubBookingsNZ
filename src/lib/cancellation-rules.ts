export interface CancellationRuleLike {
  daysBeforeStay: number
  refundPercentage: number
  creditRefundPercentage?: number | null
  fixedFeeCents?: number | null
  creditFixedFeeCents?: number | null
}

export interface NormalizedCancellationRule {
  daysBeforeStay: number
  refundPercentage: number
  creditRefundPercentage: number
  fixedFeeCents: number
  creditFixedFeeCents: number
}

export function normalizeCancellationRule(
  rule: CancellationRuleLike
): NormalizedCancellationRule {
  const cardFixedFeeCents = rule.fixedFeeCents ?? 0

  return {
    daysBeforeStay: rule.daysBeforeStay,
    refundPercentage: rule.refundPercentage,
    creditRefundPercentage: rule.creditRefundPercentage ?? rule.refundPercentage,
    fixedFeeCents: cardFixedFeeCents,
    creditFixedFeeCents: rule.creditFixedFeeCents ?? cardFixedFeeCents,
  }
}

export function normalizeCancellationRules(
  rules: CancellationRuleLike[]
): NormalizedCancellationRule[] {
  return rules.map(normalizeCancellationRule)
}

export function hasDuplicateCancellationThresholds(
  rules: readonly Pick<CancellationRuleLike, "daysBeforeStay">[]
): boolean {
  const seen = new Set<number>()
  return rules.some((rule) => {
    if (seen.has(rule.daysBeforeStay)) return true
    seen.add(rule.daysBeforeStay)
    return false
  })
}

export function normalizeStoredCancellationRules(
  rules: unknown
): NormalizedCancellationRule[] {
  if (!Array.isArray(rules)) {
    return []
  }

  return rules.map((rule) => normalizeCancellationRule(rule as CancellationRuleLike))
}
