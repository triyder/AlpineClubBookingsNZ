import type { DisplayState, DisplayStateBooking } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";
import { shortDay, stayStatusOn, type StayStatus } from "./status-helpers";

// Tonight's rooms (issue #115; visual reference: origin five-panel mock O2 in
// Grads/lobby-display/origin-five-panel.html). A grid of room cards for a
// SINGLE night — window.start ("tonight"). Each card lists the guests sleeping
// in that room tonight with their stay span and an arrive / stay / depart dot;
// an unoccupied room renders a dashed "free" card. Pure function of the
// privacy-reduced DisplayState — names come only from booking.guests, and a
// withheld booking (family / group / counts-only) shows its label + count,
// never invented names.
//
// Requires bed allocation (state.rooms !== null). With allocation off there are
// no rooms to draw, so the module degrades to a short note rather than an empty
// or broken card — the arrivals/status boards cover the roomless case.

interface RoomPerson {
  key: string;
  label: string;
  status: StayStatus;
  span: string;
  /** Withheld / group row — rendered with the group (purple) treatment. */
  group: boolean;
  /** 1 for a named guest; the booking's guestCount for a withheld row. */
  headcount: number;
}

function spanText(
  stay: { stayStart: string; stayEnd: string },
  status: StayStatus
): string {
  if (status === "departing") return "leaves today";
  return `${shortDay(stay.stayStart)} – ${shortDay(stay.stayEnd)}`;
}

/** The people from one booking row who are present in this room tonight. */
function peopleTonight(
  booking: DisplayStateBooking,
  tonight: string
): RoomPerson[] {
  if (booking.guests === null) {
    const status = stayStatusOn(booking, tonight);
    if (status === null) return [];
    return [
      {
        key: booking.key,
        label: `${booking.label} · ${booking.guestCount}`,
        status,
        span: spanText(booking, status),
        group: true,
        headcount: booking.guestCount,
      },
    ];
  }
  const people: RoomPerson[] = [];
  booking.guests.forEach((guest, index) => {
    const status = stayStatusOn(guest, tonight);
    if (status === null) return;
    people.push({
      key: `${booking.key}-${index}`,
      label: guest.label,
      status,
      span: spanText(guest, status),
      group: false,
      headcount: 1,
    });
  });
  return people;
}

export function RoomCards({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  // Allocation off: no rooms to draw. Degrade to a short, honest note rather
  // than an empty grid — the arrivals / status boards handle the roomless view.
  if (state.rooms === null) {
    return (
      <div className="display-room-cards display-room-cards-fallback">
        <span className="display-room-cards-note">
          Room view needs bed allocation
        </span>
      </div>
    );
  }

  const tonight = state.window.start;

  return (
    <div className="display-room-cards">
      {state.rooms.map((room) => {
        const people = state.bookings
          .filter((booking) => booking.roomId === room.id)
          .flatMap((booking) => peopleTonight(booking, tonight));
        const headcount = people.reduce((sum, person) => sum + person.headcount, 0);

        if (people.length === 0) {
          return (
            <div
              key={room.id}
              className="display-room-card display-room-card-empty"
            >
              {room.name} — free
            </div>
          );
        }

        return (
          <div key={room.id} className="display-room-card">
            <div className="display-room-card-head">
              <span className="display-room-name">{room.name}</span>
              <span className="display-room-card-count">{headcount} guests</span>
            </div>
            <div className="display-room-people">
              {people.map((person) => (
                <div
                  key={person.key}
                  className="display-room-person"
                  data-group={person.group || undefined}
                >
                  <span
                    className="display-room-dot"
                    data-status={person.status}
                  />
                  <span className="display-room-person-name">{person.label}</span>
                  <span className="display-room-span">{person.span}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
