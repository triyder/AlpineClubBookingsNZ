import type { PolicyRule } from "./types"

export function PolicyPreview({ rules }: { rules: PolicyRule[] }) {
  const sortedRules = [...rules].sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)
  return (
    <ul className="space-y-1">
      {sortedRules.map((rule, index) => {
        let prefix: string
        if (index === 0) {
          prefix = `${rule.daysBeforeStay}+ days before stay:`
        } else if (rule.daysBeforeStay === 0 && index === sortedRules.length - 1) {
          prefix = `Less than ${sortedRules[index - 1]?.daysBeforeStay ?? 0} days:`
        } else {
          const prevDays = sortedRules[index - 1]?.daysBeforeStay ?? 0
          prefix = `${rule.daysBeforeStay}-${prevDays - 1} days:`
        }
        const creditDiffers = rule.creditRefundPercentage !== rule.refundPercentage
        const creditFeeDiffers = rule.creditFixedFeeCents !== rule.fixedFeeCents
        const cardFeeStr =
          rule.fixedFeeCents > 0 ? ` less $${(rule.fixedFeeCents / 100).toFixed(2)} fee` : ""
        const creditFeeStr =
          rule.creditFixedFeeCents > 0
            ? ` less $${(rule.creditFixedFeeCents / 100).toFixed(2)} fee`
            : ""
        const description = creditDiffers || creditFeeDiffers
          ? `${prefix} ${rule.refundPercentage}% card${cardFeeStr} / ${rule.creditRefundPercentage}% credit${creditFeeStr}`
          : `${prefix} ${rule.refundPercentage}% refund${cardFeeStr}`
        return (
          <li key={index} className="flex items-center space-x-2">
            <div
              className="w-3 h-3 rounded-full"
              style={{
                backgroundColor: `hsl(${(rule.refundPercentage / 100) * 120}, 70%, 50%)`,
              }}
            />
            <span className="text-sm">{description}</span>
          </li>
        )
      })}
    </ul>
  )
}
