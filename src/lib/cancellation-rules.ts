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

/**
 * Whether two rule sets would persist identically (#2143).
 *
 * Used by the booking-policy editors to decide whether an open form is dirty,
 * so a Save that changes nothing cannot reach a write route that logs an audit
 * entry and busts the public-page cache unconditionally. Deliberately
 * ORDER-INSENSITIVE on `daysBeforeStay`: every write route sorts by threshold
 * before storing, and each set's thresholds are unique (the routes reject
 * duplicates), so a re-ordered but otherwise identical set is not a change.
 * Inputs are normalised first so a stored `null` credit field and an explicit
 * card-fee mirror of it compare equal, exactly as they do in storage.
 */
export function cancellationRuleSetsEqual(
  a: readonly CancellationRuleLike[],
  b: readonly CancellationRuleLike[],
): boolean {
  if (a.length !== b.length) return false
  const sort = (rules: readonly CancellationRuleLike[]) =>
    rules
      .map(normalizeCancellationRule)
      .sort((x, y) => y.daysBeforeStay - x.daysBeforeStay)
  const left = sort(a)
  const right = sort(b)
  return left.every(
    (rule, i) =>
      rule.daysBeforeStay === right[i].daysBeforeStay &&
      rule.refundPercentage === right[i].refundPercentage &&
      rule.creditRefundPercentage === right[i].creditRefundPercentage &&
      rule.fixedFeeCents === right[i].fixedFeeCents &&
      rule.creditFixedFeeCents === right[i].creditFixedFeeCents,
  )
}

export function normalizeStoredCancellationRules(
  rules: unknown
): NormalizedCancellationRule[] {
  if (!Array.isArray(rules)) {
    return []
  }

  return rules.map((rule) => normalizeCancellationRule(rule as CancellationRuleLike))
}
