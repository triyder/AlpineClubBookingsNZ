import * as React from "react";
import {
  AlertTriangle,
  Archive,
  BadgeCheck,
  Ban,
  CheckCircle2,
  Circle,
  Clock,
  Eye,
  FileText,
  Hourglass,
  ListOrdered,
  Loader2,
  MinusCircle,
  ShieldCheck,
  Ticket,
  Undo2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type {
  BookingStatus,
  FinanceAccessLevel,
  PaymentStatus,
  SubscriptionStatus,
} from "@prisma/client";

import { cn } from "@/lib/utils";
import { bookingStatusLabel, humanizeStatus, subscriptionStatusLabel } from "@/lib/status-colors";
import { financeAccessShortLabels, type LifecycleStatusConfig } from "@/lib/admin-member-badges";

/**
 * StatusChip — the single presentation surface for every domain status the admin
 * and member apps render (booking, payment, subscription, member lifecycle,
 * finance access). "Restrained Alpine" (epic #1800): each status is resolved to
 * ONE of five semantic tones — neutral | info | success | warning | danger — each
 * backed by dark-adapting CSS tokens (#1801 `--success*`/`--warning*` plus the
 * #1804-additive `--info*`/`--danger*`), so a booking row shows a calm, uniform
 * chip family instead of up to eight bespoke hardcoded hues. Meaning is always
 * carried by icon + label, never colour alone.
 *
 * Labels come from the existing shared label maps/helpers (kept as the single
 * source of truth); this component only adds the status -> tone -> icon mapping.
 * The colour class maps in `status-colors.ts` / `admin-member-badges.ts` are left
 * untouched so existing consumers and tests keep working.
 */

/** The five semantic tones. `danger` is a hard/terminal negative; `warning` is an
 *  attention/in-limbo state; `info` is calm-informational; `success` is positive;
 *  `neutral` is inert/not-applicable. */
export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

/** The domain a status belongs to. Exported so consumers get autocomplete. */
export type StatusChipKind =
  | "booking"
  | "payment"
  | "subscription"
  | "lifecycle"
  | "financeAccess";

/** Lifecycle chips take the DERIVED label (not a raw enum). Consumers compute it
 *  with `getLifecycleStatusConfig(member).label` and pass the result. */
export type MemberLifecycleLabel = LifecycleStatusConfig["label"];

type ToneEntry = { tone: StatusTone; Icon: LucideIcon };

const FALLBACK: ToneEntry = { tone: "neutral", Icon: Circle };

// Each tone map is typed to its enum (not `Record<string, …>`) so the compiler
// enforces exhaustive coverage: if a migration adds an enum member, a missing key
// here becomes a typecheck error rather than silently falling through to FALLBACK.
// Runtime lookups still go through `pick()`, which stays undefined-safe for any
// arbitrary string (see resolveEntry).
const BOOKING_TONES: Record<BookingStatus, ToneEntry> = {
  DRAFT: { tone: "neutral", Icon: FileText },
  PENDING: { tone: "warning", Icon: Clock },
  PAYMENT_PENDING: { tone: "warning", Icon: Clock },
  CONFIRMED: { tone: "success", Icon: CheckCircle2 },
  AWAITING_REVIEW: { tone: "info", Icon: Hourglass },
  PAID: { tone: "success", Icon: BadgeCheck },
  COMPLETED: { tone: "neutral", Icon: CheckCircle2 },
  CANCELLED: { tone: "danger", Icon: XCircle },
  BUMPED: { tone: "warning", Icon: Ban },
  WAITLISTED: { tone: "info", Icon: ListOrdered },
  WAITLIST_OFFERED: { tone: "info", Icon: Ticket },
};

const PAYMENT_TONES: Record<PaymentStatus, ToneEntry> = {
  PENDING: { tone: "warning", Icon: Clock },
  PROCESSING: { tone: "info", Icon: Loader2 },
  SUCCEEDED: { tone: "success", Icon: CheckCircle2 },
  FAILED: { tone: "danger", Icon: XCircle },
  REFUNDED: { tone: "neutral", Icon: Undo2 },
  PARTIALLY_REFUNDED: { tone: "warning", Icon: Undo2 },
};

const SUBSCRIPTION_TONES: Record<SubscriptionStatus, ToneEntry> = {
  NOT_INVOICED: { tone: "neutral", Icon: FileText },
  NOT_REQUIRED: { tone: "neutral", Icon: MinusCircle },
  UNPAID: { tone: "warning", Icon: Clock },
  PAID: { tone: "success", Icon: CheckCircle2 },
  OVERDUE: { tone: "danger", Icon: AlertTriangle },
};

const LIFECYCLE_TONES: Record<MemberLifecycleLabel, ToneEntry> = {
  Active: { tone: "success", Icon: CheckCircle2 },
  Inactive: { tone: "neutral", Icon: Circle },
  Cancelled: { tone: "warning", Icon: Ban },
  Archived: { tone: "neutral", Icon: Archive },
};

const FINANCE_ACCESS_TONES: Record<FinanceAccessLevel, ToneEntry> = {
  NONE: { tone: "neutral", Icon: MinusCircle },
  VIEWER: { tone: "info", Icon: Eye },
  MANAGER: { tone: "success", Icon: ShieldCheck },
};

/** Tone -> chip classes. Every pair dark-adapts and clears WCAG AA (verified in
 *  status-chip.test.tsx). Neutral uses `--foreground` on `--muted` (not
 *  `--muted-foreground`, which is only 4.34:1 on `--muted` in light mode). */
const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-muted text-foreground",
  info: "bg-info-muted text-info",
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  danger: "bg-danger-muted text-danger",
};

type StatusChipCommon = Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  "children" | "color"
> & {
  /** Override the resolved label text (tone + icon still derive from `value`).
   *  Use e.g. to show "Finance Manager" instead of the default short "Manager". */
  label?: string;
};

export type StatusChipProps =
  | ({ kind: "booking"; value: BookingStatus } & StatusChipCommon)
  | ({ kind: "payment"; value: PaymentStatus } & StatusChipCommon)
  | ({ kind: "subscription"; value: SubscriptionStatus } & StatusChipCommon)
  | ({ kind: "lifecycle"; value: MemberLifecycleLabel } & StatusChipCommon)
  | ({ kind: "financeAccess"; value: FinanceAccessLevel } & StatusChipCommon);

// The tone maps are exhaustively enum-keyed, but `value` arrives as an arbitrary
// string (Prisma types narrow it, yet callers can widen). `pick` indexes through a
// partial view so an unknown value resolves to FALLBACK instead of an unchecked
// `undefined`, preserving the crash-safe unknown-value path the tests cover.
function pick<K extends string>(map: Record<K, ToneEntry>, value: string): ToneEntry {
  return (map as Partial<Record<string, ToneEntry>>)[value] ?? FALLBACK;
}

function resolveEntry(kind: StatusChipKind, value: string): ToneEntry {
  switch (kind) {
    case "booking":
      return pick(BOOKING_TONES, value);
    case "payment":
      return pick(PAYMENT_TONES, value);
    case "subscription":
      return pick(SUBSCRIPTION_TONES, value);
    case "lifecycle":
      return pick(LIFECYCLE_TONES, value);
    case "financeAccess":
      return pick(FINANCE_ACCESS_TONES, value);
    default:
      return FALLBACK;
  }
}

function resolveLabel(kind: StatusChipKind, value: string): string {
  switch (kind) {
    case "booking":
      return bookingStatusLabel(value);
    case "subscription":
      return subscriptionStatusLabel(value);
    case "financeAccess":
      return financeAccessShortLabels[value as FinanceAccessLevel] ?? humanizeStatus(value);
    case "lifecycle":
      // The lifecycle "label map" is identity: the value IS the display label
      // (derived upstream by getLifecycleStatusConfig).
      return value;
    case "payment":
      // No shared payment label map exists; humanizeStatus is the established
      // shared helper ("PARTIALLY_REFUNDED" -> "Partially refunded").
      return humanizeStatus(value);
    default:
      return humanizeStatus(value);
  }
}

/**
 * Render a domain status as an icon + label chip in one of five semantic tones.
 *
 * @example
 * <StatusChip kind="booking" value={booking.status} />
 * <StatusChip kind="payment" value={payment.status} />
 * <StatusChip kind="lifecycle" value={getLifecycleStatusConfig(member).label} />
 * <StatusChip kind="financeAccess" value={member.financeAccess} label="Finance Manager" />
 */
export function StatusChip({ kind, value, label, className, ...props }: StatusChipProps) {
  const { tone, Icon } = resolveEntry(kind, value);
  const text = label ?? resolveLabel(kind, value);

  return (
    <span
      data-slot="status-chip"
      data-kind={kind}
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{text}</span>
    </span>
  );
}
