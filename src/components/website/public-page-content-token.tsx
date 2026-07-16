import type {
  PublicBookingPolicy,
  PublicCancellationPolicy,
  PublicFeeGroup,
} from "@/lib/public-page-content-tokens";

function EmptyToken() {
  return <p className="text-brand-deep/70">No public information is currently available.</p>;
}

/**
 * The single grouped-table renderer for all three fee embeds — hut fees,
 * joining fees, and annual fees (#1933, E7). Each group is a titled block; rows
 * carry a label, an optional audience qualifier, and the amount. It makes no
 * assumption about its position on the page: it renders standalone and can be
 * repeated. Empty (or all-empty) groups collapse to the shared empty state so
 * an unknown/unlisted parameter never leaks another group's data.
 */
export function FeeGroupsToken({ groups }: { groups: PublicFeeGroup[] }) {
  const populated = groups.filter((group) => group.rows.length > 0);
  if (populated.length === 0) return <EmptyToken />;
  return (
    <div className="space-y-6">
      {populated.map((group, groupIndex) => (
        <section key={`${group.heading}-${groupIndex}`}>
          <h3>{group.heading}</h3>
          <dl className="mt-2">
            {group.rows.map((row, rowIndex) => (
              <div
                key={`${row.label}-${row.audience ?? ""}-${rowIndex}`}
                className="flex justify-between gap-4 border-t border-brand-mist py-2"
              >
                <dt>
                  {row.label}
                  {row.audience ? <span className="text-brand-deep/70"> — {row.audience}</span> : null}
                </dt>
                <dd className="font-semibold tabular-nums">{row.fee.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

export function BookingPolicyToken({ policy }: { policy: PublicBookingPolicy | null }) {
  if (!policy || (!policy.hold && policy.periods.length === 0 && policy.minimumStays.length === 0 && !policy.groupDiscount)) return <EmptyToken />;
  return <section className="space-y-5">{policy.lodge && <h2>{policy.lodge.name}</h2>}{policy.hold && <p>{policy.hold}</p>}{policy.periods.length > 0 && <div><h3>Booking periods</h3><ul>{policy.periods.map((period) => <li key={`${period.name}-${period.dateRange}`}><strong>{period.name}</strong> ({period.dateRange}){period.hold ? ` — ${period.hold}` : ""}</li>)}</ul></div>}{policy.minimumStays.length > 0 && <div><h3>Minimum stays</h3><ul>{policy.minimumStays.map((rule) => <li key={`${rule.name}-${rule.dateRange}`}><strong>{rule.name}</strong> ({rule.dateRange}): {rule.minimumNights} {rule.minimumNights === 1 ? "night" : "nights"}; applies to {rule.triggerDays}</li>)}</ul></div>}{policy.groupDiscount && <p>{policy.groupDiscount}</p>}</section>;
}

export function CancellationPolicyToken({ policy }: { policy: PublicCancellationPolicy | null }) {
  if (!policy || (policy.tiers.length === 0 && policy.periods.length === 0)) return <EmptyToken />;
  return <section><h2>{policy.lodge ? `${policy.lodge.name} cancellation policy` : "Cancellation policy"}</h2><ul>{policy.tiers.map((tier) => <li key={tier.description}>{tier.description}</li>)}</ul>{policy.periods.map((period) => <div key={`${period.name}-${period.dateRange}`}><h3>{period.name}</h3><p>{period.dateRange}</p><ul>{period.tiers.map((tier) => <li key={tier.description}>{tier.description}</li>)}</ul></div>)}</section>;
}
