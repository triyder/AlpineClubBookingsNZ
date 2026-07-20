import type {
  PublicBookingPolicy,
  PublicCancellationPolicy,
  PublicFeeGroup,
  PublicFeeTable,
} from "@/lib/public-page-content-tokens";

function EmptyToken() {
  return <p className="text-brand-deep/70">No public information is currently available.</p>;
}

/**
 * The grouped definition-list renderer for the joining-fee and annual-fee
 * embeds (#1933, E7). Each group is a titled block; rows carry a label and the
 * amount. It makes no assumption about its position on the page: it renders
 * standalone and can be repeated. Empty (or all-empty) groups collapse to the
 * shared empty state so an unknown/unlisted parameter never leaks another
 * group's data. Hut fees render through `FeeTableToken` instead (#2129).
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
                key={`${row.label}-${rowIndex}`}
                className="flex justify-between gap-4 border-t border-brand-mist py-2"
              >
                <dt>{row.label}</dt>
                <dd className="font-semibold tabular-nums">{row.fee.label}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/**
 * The tabular renderer for the public `{{hut-fees}}` embed (#2129). One real
 * `<table>` per lodge x season: the leading column carries the row labels (age
 * tiers, or membership types when the embed is transposed with
 * `group-by=age`), and every other column is one collapsed membership-type rate
 * column. A missing rate renders as an em dash, never a zero.
 *
 * Mobile treatment: the table keeps its natural width and scrolls horizontally
 * inside its own `overflow-x-auto` container, so a wide rate grid never makes
 * the page body scroll sideways.
 */
export function FeeTableToken({ tables }: { tables: PublicFeeTable[] }) {
  const populated = tables.filter((table) => table.rows.length > 0 && table.columns.length > 0);
  if (populated.length === 0) return <EmptyToken />;
  return (
    <div className="space-y-6">
      {populated.map((table, tableIndex) => (
        <section key={`${table.heading}-${tableIndex}`}>
          <h3>{table.heading}</h3>
          <div className="mt-2 max-w-full overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-left">
              <thead>
                <tr>
                  <th scope="col" className="border-b border-brand-mist py-2 pr-6">
                    {table.rowHeading}
                  </th>
                  {table.columns.map((column, columnIndex) => (
                    <th
                      key={`${column}-${columnIndex}`}
                      scope="col"
                      className="border-b border-brand-mist py-2 pr-6 text-right last:pr-0"
                    >
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row, rowIndex) => (
                  <tr key={`${row.label}-${rowIndex}`}>
                    <th scope="row" className="border-t border-brand-mist py-2 pr-6 font-normal">
                      {row.label}
                    </th>
                    {row.cells.map((cell, cellIndex) => (
                      <td
                        key={`${row.label}-cell-${cellIndex}`}
                        className="border-t border-brand-mist py-2 pr-6 text-right font-semibold tabular-nums last:pr-0"
                      >
                        {cell ? cell.label : "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
