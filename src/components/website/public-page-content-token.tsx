import type {
  PublicBookingPolicy,
  PublicCancellationPolicy,
  PublicEntranceFee,
  PublicHutFeeLodge,
  PublicMembershipType,
} from "@/lib/public-page-content-tokens";

function EmptyToken() {
  return <p className="text-brand-deep/70">No public information is currently available.</p>;
}

export function MembershipTypesToken({ items }: { items: PublicMembershipType[] }) {
  if (items.length === 0) return <EmptyToken />;
  return <div className="grid gap-5 md:grid-cols-2">{items.map((item) => <article key={item.name} className="rounded-lg border border-brand-mist p-5"><h2>{item.name}</h2>{item.description && <p>{item.description}</p>}{item.annualFee ? <p><strong>{item.annualFee.label}</strong> annually{item.billingLabel ? ` (${item.billingLabel.toLowerCase()})` : ""}</p> : item.billingLabel ? <p>{item.billingLabel}</p> : null}</article>)}</div>;
}

export function EntranceFeesToken({ items }: { items: PublicEntranceFee[] }) {
  if (items.length === 0) return <EmptyToken />;
  return <dl className="grid gap-3 sm:grid-cols-2">{items.map((item) => <div key={item.category} className="flex justify-between rounded-lg border border-brand-mist p-4"><dt>{item.category}</dt><dd className="font-semibold tabular-nums">{item.fee.label}</dd></div>)}</dl>;
}

export function HutFeesToken({ lodges }: { lodges: PublicHutFeeLodge[] }) {
  if (lodges.length === 0) return <EmptyToken />;
  return <div className="space-y-8">{lodges.map((lodge) => <section key={lodge.slug}><h2>{lodge.name}</h2>{lodge.seasons.length === 0 ? <EmptyToken /> : lodge.seasons.map((season) => <article key={`${season.name}-${season.dateRange}`} className="mb-5 rounded-lg border border-brand-mist p-5"><h3>{season.name}</h3><p>{season.dateRange}</p><dl>{season.rates.map((rate) => <div key={`${rate.ageTier}-${rate.audience}`} className="flex justify-between gap-4 border-t border-brand-mist py-2"><dt>{rate.ageTier} — {rate.audience}</dt><dd className="font-semibold tabular-nums">{rate.fee.label} per night</dd></div>)}</dl></article>)}</section>)}</div>;
}

export function BookingPolicyToken({ policy }: { policy: PublicBookingPolicy | null }) {
  if (!policy || (!policy.hold && policy.periods.length === 0 && policy.minimumStays.length === 0 && !policy.groupDiscount)) return <EmptyToken />;
  return <section className="space-y-5">{policy.lodge && <h2>{policy.lodge.name}</h2>}{policy.hold && <p>{policy.hold}</p>}{policy.periods.length > 0 && <div><h3>Booking periods</h3><ul>{policy.periods.map((period) => <li key={`${period.name}-${period.dateRange}`}><strong>{period.name}</strong> ({period.dateRange}){period.hold ? ` — ${period.hold}` : ""}</li>)}</ul></div>}{policy.minimumStays.length > 0 && <div><h3>Minimum stays</h3><ul>{policy.minimumStays.map((rule) => <li key={`${rule.name}-${rule.dateRange}`}><strong>{rule.name}</strong> ({rule.dateRange}): {rule.minimumNights} {rule.minimumNights === 1 ? "night" : "nights"}; applies to {rule.triggerDays}</li>)}</ul></div>}{policy.groupDiscount && <p>{policy.groupDiscount}</p>}</section>;
}

export function CancellationPolicyToken({ policy }: { policy: PublicCancellationPolicy | null }) {
  if (!policy || (policy.tiers.length === 0 && policy.periods.length === 0)) return <EmptyToken />;
  return <section><h2>{policy.lodge ? `${policy.lodge.name} cancellation policy` : "Cancellation policy"}</h2><ul>{policy.tiers.map((tier) => <li key={tier.description}>{tier.description}</li>)}</ul>{policy.periods.map((period) => <div key={`${period.name}-${period.dateRange}`}><h3>{period.name}</h3><p>{period.dateRange}</p><ul>{period.tiers.map((tier) => <li key={tier.description}>{tier.description}</li>)}</ul></div>)}</section>;
}
