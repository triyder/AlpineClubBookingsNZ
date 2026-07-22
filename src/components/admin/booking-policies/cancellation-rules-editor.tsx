"use client"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { PolicyRule } from "./types"

export function CancellationRulesEditor({
  rules,
  onChange,
  disabled = false,
}: {
  rules: PolicyRule[]
  onChange: (rules: PolicyRule[]) => void
  disabled?: boolean
}) {
  function addRule() {
    onChange([
      ...rules,
      {
        daysBeforeStay: 0,
        refundPercentage: 0,
        creditRefundPercentage: 0,
        fixedFeeCents: 0,
        creditFixedFeeCents: 0,
      },
    ])
  }
  function removeRule(index: number) {
    onChange(rules.filter((_, i) => i !== index))
  }
  function updateRule(index: number, field: keyof PolicyRule, value: number) {
    onChange(rules.map((r, i) => (i === index ? { ...r, [field]: value } : r)))
  }

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Days Before Stay (min)</TableHead>
            <TableHead>Card Refund %</TableHead>
            <TableHead>Credit Refund %</TableHead>
            <TableHead>Card Fixed Fee ($)</TableHead>
            <TableHead>Credit Fixed Fee ($)</TableHead>
            <TableHead className="w-20"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rules.map((rule, index) => (
            <TableRow key={index}>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    value={rule.daysBeforeStay}
                    onChange={(e) =>
                      updateRule(index, "daysBeforeStay", parseInt(e.target.value) || 0)
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={rule.refundPercentage}
                    onChange={(e) =>
                      updateRule(index, "refundPercentage", parseInt(e.target.value) || 0)
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={rule.creditRefundPercentage}
                    onChange={(e) =>
                      updateRule(index, "creditRefundPercentage", parseInt(e.target.value) || 0)
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                  <span className="text-sm text-muted-foreground">%</span>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={((rule.fixedFeeCents ?? 0) / 100).toFixed(2)}
                    onChange={(e) =>
                      updateRule(index, "fixedFeeCents", Math.round((parseFloat(e.target.value) || 0) * 100))
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center space-x-2">
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={((rule.creditFixedFeeCents ?? 0) / 100).toFixed(2)}
                    onChange={(e) =>
                      updateRule(
                        index,
                        "creditFixedFeeCents",
                        Math.round((parseFloat(e.target.value) || 0) * 100)
                      )
                    }
                    className={`w-24 ${disabled ? "bg-muted text-muted-foreground" : ""}`}
                    disabled={disabled}
                  />
                </div>
              </TableCell>
              <TableCell>
                {!disabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeRule(index)}
                    disabled={rules.length <= 1}
                  >
                    Remove
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!disabled && (
        <Button variant="outline" size="sm" onClick={addRule}>
          Add Rule
        </Button>
      )}
    </div>
  )
}
