// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@/lib/__tests__/support/club-time-render";
import { describe, expect, it } from "vitest";

import { RequestedGuestNights } from "@/components/admin/booking-requests/requested-guest-nights";
import { formatStayDate } from "@/lib/club-time";
import { CLUB_FORMAT_TEST } from "@/lib/__tests__/support/club-format-fixture";
import { describeRequestedGuestNights } from "@/lib/booking-change-request-stored";

/**
 * #4088: the officer's card lists each guest's requested nights as runs, in the
 * club's date format, so a grid request's gaps are visible before approving.
 */
describe("RequestedGuestNights", () => {
  const day = (value: string) => formatStayDate(value, CLUB_FORMAT_TEST);

  it("lists runs, the whole stay for an added guest with no nights, and an unchanged guest", () => {
    render(
      <RequestedGuestNights
        format={CLUB_FORMAT_TEST}
        guests={[
          {
            name: "Jo Bloggs",
            runs: [
              { firstNight: "2026-07-03", lastNight: "2026-07-04" },
              { firstNight: "2026-07-06", lastNight: "2026-07-06" },
            ],
            nightCount: 3,
            added: false,
            unchanged: false,
            fillsGaps: false,
          },
          { name: "Ari Example", runs: [], nightCount: null, added: true, unchanged: false, fillsGaps: false },
          {
            name: "Sam Example",
            runs: [{ firstNight: "2026-07-03", lastNight: "2026-07-06" }],
            nightCount: 4,
            added: false,
            unchanged: true,
            fillsGaps: false,
          },
          {
            name: "Lee Example",
            runs: [{ firstNight: "2026-07-03", lastNight: "2026-07-03" }],
            nightCount: 1,
            added: false,
            unchanged: false,
            fillsGaps: true,
          },
        ]}
      />,
    );
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual([
      `Jo Bloggs: 3 nights: ${day("2026-07-03")} – ${day("2026-07-04")}, ${day("2026-07-06")}`,
      "Ari Example (added): the whole stay",
      `Sam Example: 4 nights: ${day("2026-07-03")} – ${day("2026-07-06")} (no change)`,
      `Lee Example: 1 night: ${day("2026-07-03")} (fills the gaps in their stay)`,
    ]);
  });

  it("reads a gapped guest whose range repeats their own dates as no change, with the nights they keep (#4157)", () => {
    const guest = (stayEnd: string) => ({
      original: {
        checkIn: "2026-07-03",
        checkOut: "2026-07-06",
        guests: [
          {
            id: "guest-1",
            firstName: "Lee",
            lastName: "Example",
            stayStart: "2026-07-03",
            stayEnd: "2026-07-06",
            nights: ["2026-07-03", "2026-07-05"],
          },
        ],
      },
      requested: { guestStayRanges: [{ guestId: "guest-1", stayStart: "2026-07-03", stayEnd }] },
    });
    const { unmount } = render(
      <RequestedGuestNights format={CLUB_FORMAT_TEST} guests={describeRequestedGuestNights(guest("2026-07-06"), { status: "REQUESTED" })} />,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent(
      `Lee Example: 2 nights: ${day("2026-07-03")}, ${day("2026-07-05")} (no change)`,
    );
    unmount();
    // A Date Out that really moves still re-spreads the stay, gap and all.
    render(
      <RequestedGuestNights format={CLUB_FORMAT_TEST} guests={describeRequestedGuestNights(guest("2026-07-07"), { status: "REQUESTED" })} />,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent(
      `Lee Example: 4 nights: ${day("2026-07-03")} – ${day("2026-07-06")} (fills the gaps in their stay)`,
    );
  });

  it("renders nothing for a request that names no guest's nights", () => {
    const { container } = render(<RequestedGuestNights format={CLUB_FORMAT_TEST} guests={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
