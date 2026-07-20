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
 * INVARIANT — `row.cells` holds `PublicMoney` OBJECTS or `null`, never bare
 * numbers. The `{cell ? ... : em dash}` test below is only zero-safe because of
 * that: a free $0.00 infant night is a truthy object. Flattening `cells` to
 * `Array<number | null>` would make `0` falsy and silently render a genuinely
 * free rate as "no rate" — a money bug with no type error. Keep the objects.
 *
 * Mobile treatment: the table keeps its natural width and scrolls horizontally
 * inside its own `overflow-x-auto` container, so a wide rate grid never makes
 * the page body scroll sideways. That container is a focusable, named `region`
 * so keyboard-only visitors can reach columns clipped off-screen (WCAG 2.1.1 —
 * axe `scrollable-region-focusable`; Chrome auto-focuses scrollers, Safari and
 * Firefox do not).
 */
export function FeeTableToken({
  tables,
  idPrefix = "hut-fees",
}: {
  tables: PublicFeeTable[];
  /** Page-unique namespace for generated ids; several embeds may share a page. */
  idPrefix?: string;
}) {
  const populated = tables.filter((table) => table.rows.length > 0 && table.columns.length > 0);
  if (populated.length === 0) return <EmptyToken />;
  return (
    <div className="space-y-6">
      {populated.map((table, tableIndex) => {
        const headingId = `${idPrefix}-${tableIndex}-heading`;
        return (
          <section key={`${table.heading}-${tableIndex}`} aria-labelledby={headingId}>
            <h3 id={headingId}>{table.heading}</h3>
            <div
              className="mt-2 max-w-full overflow-x-auto"
              role="region"
              tabIndex={0}
              aria-labelledby={headingId}
            >
              {/*
                Each page can emit many of these tables (lodges x seasons, and
                more again under `group-by=type`). Unnamed, a screen reader
                announces every one as an indistinguishable "table, N columns,
                M rows", so name each from its own heading. `aria-labelledby`
                rather than an sr-only <caption> so the heading text exists once
                in the DOM instead of twice.
              */}
              <table
                className="w-full min-w-max border-collapse text-left"
                aria-labelledby={headingId}
              >
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
                          {cell ? (
                            cell.label
                          ) : (
                            <>
                              {/*
                                NVDA and JAWS do not speak a bare em dash at
                                default verbosity, so an empty cell would be
                                announced as "blank" — indistinguishable from a
                                broken render. Show the dash, speak the meaning.
                              */}
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">No rate</span>
                            </>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {table.collapsedColumns && (
              <p className="mt-2 text-sm text-brand-deep/70">
                Types sharing a column are charged the same nightly rate.
              </p>
            )}
          </section>
        );
      })}
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
