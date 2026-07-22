// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { StatusChip, type StatusChipProps } from "@/components/ui/status-chip";
import { contrastRatio } from "@/lib/club-theme-schema";

function renderChip(kind: string, value: string, label?: string) {
  const props = { kind, value, label } as unknown as StatusChipProps;
  return render(<StatusChip {...props} />);
}

type Case = { kind: string; value: string; label: string; tone: string };

const CASES: Case[] = [
  // booking
  { kind: "booking", value: "DRAFT", label: "Draft", tone: "neutral" },
  { kind: "booking", value: "PENDING", label: "Pending", tone: "warning" },
  { kind: "booking", value: "PAYMENT_PENDING", label: "Payment Pending", tone: "warning" },
  { kind: "booking", value: "CONFIRMED", label: "Confirmed (Unpaid)", tone: "success" },
  { kind: "booking", value: "AWAITING_REVIEW", label: "Awaiting Review", tone: "info" },
  { kind: "booking", value: "PAID", label: "Paid", tone: "success" },
  { kind: "booking", value: "COMPLETED", label: "Completed", tone: "neutral" },
  { kind: "booking", value: "CANCELLED", label: "Cancelled", tone: "danger" },
  { kind: "booking", value: "BUMPED", label: "Bumped", tone: "warning" },
  { kind: "booking", value: "WAITLISTED", label: "Waitlisted", tone: "info" },
  { kind: "booking", value: "WAITLIST_OFFERED", label: "Waitlist Offered", tone: "info" },
  // payment
  { kind: "payment", value: "PENDING", label: "Pending", tone: "warning" },
  // PROCESSING / REFUNDED / PARTIALLY_REFUNDED get distinct accent hues (#156)
  // so the payments table shows each state instead of collapsing them onto
  // info/neutral/warning.
  { kind: "payment", value: "PROCESSING", label: "Processing", tone: "indigo" },
  { kind: "payment", value: "SUCCEEDED", label: "Succeeded", tone: "success" },
  { kind: "payment", value: "FAILED", label: "Failed", tone: "danger" },
  { kind: "payment", value: "REFUNDED", label: "Refunded", tone: "purple" },
  { kind: "payment", value: "PARTIALLY_REFUNDED", label: "Partially refunded", tone: "teal" },
  // subscription
  { kind: "subscription", value: "NOT_INVOICED", label: "Not Invoiced", tone: "neutral" },
  { kind: "subscription", value: "NOT_REQUIRED", label: "Not Required", tone: "neutral" },
  { kind: "subscription", value: "UNPAID", label: "Unpaid", tone: "warning" },
  { kind: "subscription", value: "PAID", label: "Paid", tone: "success" },
  { kind: "subscription", value: "OVERDUE", label: "Overdue", tone: "danger" },
  // lifecycle (value is the derived label)
  { kind: "lifecycle", value: "Active", label: "Active", tone: "success" },
  { kind: "lifecycle", value: "Inactive", label: "Inactive", tone: "neutral" },
  { kind: "lifecycle", value: "Cancelled", label: "Cancelled", tone: "warning" },
  { kind: "lifecycle", value: "Archived", label: "Archived", tone: "neutral" },
  // financeAccess (short labels)
  { kind: "financeAccess", value: "NONE", label: "None", tone: "neutral" },
  { kind: "financeAccess", value: "VIEWER", label: "Viewer", tone: "info" },
  { kind: "financeAccess", value: "MANAGER", label: "Manager", tone: "success" },
];

describe("StatusChip resolves label + tone + icon per kind", () => {
  it.each(CASES)("$kind/$value -> $label ($tone)", ({ kind, value, label, tone }) => {
    const { container } = renderChip(kind, value);
    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip).toBeTruthy();
    expect(chip?.getAttribute("data-kind")).toBe(kind);
    expect(chip?.getAttribute("data-tone")).toBe(tone);
    expect(chip?.textContent).toContain(label);
    // Icon + label, never colour alone.
    const svg = chip?.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
  });

  it("every kind reaches at least one non-neutral tone (colour is semantic)", () => {
    const byKind = new Map<string, Set<string>>();
    for (const c of CASES) {
      const set = byKind.get(c.kind) ?? new Set<string>();
      set.add(c.tone);
      byKind.set(c.kind, set);
    }
    for (const [, tones] of byKind) {
      expect([...tones].some((t) => t !== "neutral")).toBe(true);
    }
  });
});

describe("StatusChip presentation contract", () => {
  it("applies the resolved tone background/text utility classes", () => {
    const { container } = renderChip("booking", "CONFIRMED");
    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip?.className).toContain("bg-success-3");
    expect(chip?.className).toContain("text-success-11");
  });

  // Not because `--muted-foreground` fails AA on `--muted` — since #2145 the
  // app-scope muted tone is clamped to clear AA on both surfaces. A status chip
  // carries meaning, so it reads at full text weight like its coloured siblings.
  it("neutral uses text-foreground, at full text weight like its siblings", () => {
    const { container } = renderChip("booking", "DRAFT");
    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip?.className).toContain("bg-muted");
    expect(chip?.className).toContain("text-foreground");
  });

  it("danger uses the additive --danger* tokens, not solid destructive", () => {
    const { container } = renderChip("booking", "CANCELLED");
    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip?.className).toContain("bg-danger-3");
    expect(chip?.className).toContain("text-danger-11");
    expect(chip?.className).not.toContain("bg-destructive");
  });

  it("label prop overrides the resolved label but keeps value-derived tone", () => {
    const { container } = renderChip("financeAccess", "MANAGER", "Finance Manager");
    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip?.textContent).toBe("Finance Manager");
    expect(chip?.getAttribute("data-tone")).toBe("success");
  });

  it("unknown value falls back to neutral + humanized label (defensive)", () => {
    const { container } = renderChip("booking", "MYSTERY_STATE");
    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip?.getAttribute("data-tone")).toBe("neutral");
    expect(chip?.textContent).toContain("Mystery state");
  });

  it("merges a caller className", () => {
    const props = { kind: "booking", value: "PAID", className: "custom-x" } as unknown as StatusChipProps;
    const { container } = render(<StatusChip {...props} />);
    const chip = container.querySelector('[data-slot="status-chip"]');
    expect(chip?.className).toContain("custom-x");
  });
});

describe("StatusChip tone tokens clear WCAG AA (matches globals.css)", () => {
  const lightPairs: Array<[string, string, string]> = [
    ["info", "#1e40af", "#dbeafe"],
    ["danger", "#991b1b", "#fee2e2"],
    ["success", "#166534", "#dcfce7"],
    ["warning", "#854d0e", "#fef9c3"],
    ["neutral", "oklch(0.145 0 0)", "oklch(0.97 0 0)"],
    // Per-value accent hues (#156): -800 text on -100 tint (mirrors globals.css).
    ["orange", "#9a3412", "#ffedd5"],
    ["teal", "#115e59", "#ccfbf1"],
    ["indigo", "#3730a3", "#e0e7ff"],
    ["purple", "#6b21a8", "#f3e8ff"],
    ["emerald", "#065f46", "#d1fae5"],
  ];
  const darkPairs: Array<[string, string, string]> = [
    // hue 250 kept byte-identical to the sibling Alert lane (#1802).
    ["info", "oklch(0.84 0.11 250)", "oklch(0.33 0.05 250)"],
    ["danger", "oklch(0.84 0.11 27)", "oklch(0.33 0.05 27)"],
    ["neutral", "oklch(0.985 0 0)", "oklch(0.32 0 0)"],
    // Accent hues (#156): same lightness structure as the semantic pairs, so
    // contrast is hue-independent and clears AA at every hue.
    ["orange", "oklch(0.84 0.11 55)", "oklch(0.33 0.05 55)"],
    ["teal", "oklch(0.84 0.11 185)", "oklch(0.33 0.05 185)"],
    ["indigo", "oklch(0.84 0.11 275)", "oklch(0.33 0.05 275)"],
    ["purple", "oklch(0.84 0.11 315)", "oklch(0.33 0.05 315)"],
    ["emerald", "oklch(0.84 0.11 165)", "oklch(0.33 0.05 165)"],
  ];

  it.each(lightPairs)("light %s text-on-muted >= 4.5:1", (_tone, fg, bg) => {
    const ratio = contrastRatio(fg, bg);
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeGreaterThanOrEqual(4.5);
  });

  it.each(darkPairs)("dark %s text-on-muted >= 4.5:1", (_tone, fg, bg) => {
    const ratio = contrastRatio(fg, bg);
    expect(ratio).not.toBeNull();
    expect(ratio ?? 0).toBeGreaterThanOrEqual(4.5);
  });
});
