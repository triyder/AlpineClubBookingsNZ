import { formatStayDate, type ClubDateFormat } from "@/lib/club-time";
import type { RequestedGuestNights as RequestedGuestNightsRow } from "@/lib/booking-change-request-stored";

/**
 * "3 nights: 3 Jul 2026 – 4 Jul 2026, 6 Jul 2026", in the club's own date
 * format. Counted and labelled as nights so a run is never read as the
 * booking's check-in to check-out (the last date is a night, not a departure).
 */
function describeRuns(
  { runs, nightCount }: Pick<RequestedGuestNightsRow, "runs" | "nightCount">,
  format: ClubDateFormat,
): string {
  if (runs.length === 0 || nightCount === null) return "the whole stay";
  const dates = runs
    .map(({ firstNight, lastNight }) =>
      firstNight === lastNight
        ? formatStayDate(firstNight, format)
        : `${formatStayDate(firstNight, format)} – ${formatStayDate(lastNight, format)}`,
    )
    .join(", ");
  return `${nightCount} night${nightCount === 1 ? "" : "s"}: ${dates}`;
}

/**
 * #4088: each guest's nights as the request asks for them, so the officer sees
 * a grid request's gaps before approving applies them. Nights are listed as
 * runs of consecutive nights (first and last night, not the departure
 * morning); an existing guest whose nights the request repeats is marked, and
 * so is one whose moved Date In and Date Out would fill the gaps in their stay.
 * A gapped guest whose request only repeats their own dates keeps their nights
 * (#4157) and is listed with those nights, marked as no change.
 */
export function RequestedGuestNights({
  guests,
  format,
}: {
  guests: ReadonlyArray<RequestedGuestNightsRow> | undefined;
  format: ClubDateFormat;
}) {
  if (!guests || guests.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-muted-foreground" aria-label="Nights this request asks for">
      {guests.map((guest, index) => (
        <li key={`${guest.name}-${index}`}>
          {guest.name}
          {guest.added ? " (added)" : ""}: {describeRuns(guest, format)}
          {guest.unchanged ? " (no change)" : ""}
          {guest.fillsGaps ? " (fills the gaps in their stay)" : ""}
        </li>
      ))}
    </ul>
  );
}
