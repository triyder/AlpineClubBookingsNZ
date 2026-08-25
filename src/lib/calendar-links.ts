/**
 * Add-to-calendar links for a booking's stay (fork issue #35).
 *
 * A lodge stay is an NZ date-only night range (INV-DATE-001), so every link
 * here describes an ALL-DAY calendar event — `VALUE=DATE` in the .ics,
 * `YYYYMMDD/YYYYMMDD` in the Google URL, `allday=true` in the Outlook URL —
 * never a datetime, which would re-import the host-timezone ambiguity the
 * Club Time work removes. The event spans check-in through the checkout day
 * inclusive (the guest is at the lodge until the midday-NZ stay boundary), and
 * every all-day end below is EXCLUSIVE per its format, so each end date is
 * checkout + 1 day.
 *
 * The .ics download URL must work from an email with no signed-in session, so
 * it carries an HMAC of the booking id under the app auth secret — the same
 * sessionless-credential pattern as lodge-display pairing. The token grants
 * exactly one thing: reading one booking's stay dates and lodge name as a
 * calendar file.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { getAppBaseUrl } from "@/lib/app-url";
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only";
import { getAuthSecret } from "@/lib/runtime-config";

export interface BookingCalendarStay {
  bookingId: string;
  /** Date-only values (UTC-midnight instants from a `@db.Date` column). */
  checkIn: Date;
  checkOut: Date;
}

export interface BookingCalendarLinks {
  icsUrl: string;
  googleUrl: string;
  outlookUrl: string;
}

function calendarSecret(): string {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error(
      "AUTH_SECRET or NEXTAUTH_SECRET is required for booking calendar links",
    );
  }
  return secret;
}

export function bookingCalendarToken(bookingId: string): string {
  return createHmac("sha256", calendarSecret())
    .update(`booking-calendar:${bookingId}`)
    .digest("base64url");
}

export function verifyBookingCalendarToken(
  bookingId: string,
  token: string,
): boolean {
  const expected = Buffer.from(bookingCalendarToken(bookingId));
  const provided = Buffer.from(token);
  return (
    expected.length === provided.length && timingSafeEqual(expected, provided)
  );
}

/** `yyyy-MM-dd` → `yyyyMMdd` (the iCal / Google compact date form). */
function compactDate(dateOnly: string): string {
  return dateOnly.replaceAll("-", "");
}

interface StayDates {
  /** Check-in day, `yyyy-MM-dd`. */
  startIso: string;
  /** Day AFTER checkout (all-day ends are exclusive), `yyyy-MM-dd`. */
  endExclusiveIso: string;
}

function stayDates(checkIn: Date, checkOut: Date): StayDates {
  return {
    startIso: formatDateOnly(checkIn),
    endExclusiveIso: formatDateOnly(addDaysDateOnly(checkOut, 1)),
  };
}

/**
 * RFC 5545 TEXT escaping: backslash, semicolon, comma, and newlines.
 */
function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/g, "\\n");
}

/**
 * RFC 5545 content lines fold at 75 octets. Splitting at 74 characters is
 * conservative for ASCII content; multi-byte lodge names may fold a byte or
 * two early, which every parser accepts.
 */
function foldIcsLine(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = rest.slice(74);
  }
  parts.push(rest);
  return parts.join("\r\n ");
}

function icsTimestamp(instant: Date): string {
  return `${instant.toISOString().slice(0, 19).replaceAll(/[-:]/g, "")}Z`;
}

/**
 * The .ics document for one stay. The UID is stable per booking, so
 * re-downloading after a date change updates the existing event in the
 * recipient's calendar instead of duplicating it.
 */
export function buildBookingIcs(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
  /** DTSTAMP instant; callers pass `new Date()` at generation time. */
  generatedAt: Date;
}): string {
  const { startIso, endExclusiveIso } = stayDates(
    input.stay.checkIn,
    input.stay.checkOut,
  );
  const host = new URL(getAppBaseUrl()).hostname;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//AlpineClubBookingsNZ//Booking Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:booking-${input.stay.bookingId}@${host}`,
    `DTSTAMP:${icsTimestamp(input.generatedAt)}`,
    `DTSTART;VALUE=DATE:${compactDate(startIso)}`,
    `DTEND;VALUE=DATE:${compactDate(endExclusiveIso)}`,
    `SUMMARY:${escapeIcsText(`${input.lodgeName} stay`)}`,
    `LOCATION:${escapeIcsText(input.lodgeName)}`,
    `DESCRIPTION:${escapeIcsText(
      `Lodge booking from ${startIso} to checkout. Manage your booking: ${getAppBaseUrl()}/bookings`,
    )}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

export function googleCalendarUrl(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
}): string {
  const { startIso, endExclusiveIso } = stayDates(
    input.stay.checkIn,
    input.stay.checkOut,
  );
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", `${input.lodgeName} stay`);
  url.searchParams.set(
    "dates",
    `${compactDate(startIso)}/${compactDate(endExclusiveIso)}`,
  );
  url.searchParams.set("location", input.lodgeName);
  url.searchParams.set(
    "details",
    `Manage your booking: ${getAppBaseUrl()}/bookings`,
  );
  return url.toString();
}

export function outlookCalendarUrl(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
}): string {
  const { startIso, endExclusiveIso } = stayDates(
    input.stay.checkIn,
    input.stay.checkOut,
  );
  const url = new URL("https://outlook.live.com/calendar/0/deeplink/compose");
  url.searchParams.set("path", "/calendar/action/compose");
  url.searchParams.set("rru", "addevent");
  url.searchParams.set("allday", "true");
  url.searchParams.set("subject", `${input.lodgeName} stay`);
  url.searchParams.set("startdt", startIso);
  url.searchParams.set("enddt", endExclusiveIso);
  url.searchParams.set("location", input.lodgeName);
  url.searchParams.set(
    "body",
    `Manage your booking: ${getAppBaseUrl()}/bookings`,
  );
  return url.toString();
}

export function bookingIcsDownloadUrl(bookingId: string): string {
  return `${getAppBaseUrl()}/api/calendar/booking/${bookingId}?token=${bookingCalendarToken(bookingId)}`;
}

export function bookingCalendarLinks(input: {
  stay: BookingCalendarStay;
  lodgeName: string;
}): BookingCalendarLinks {
  return {
    icsUrl: bookingIcsDownloadUrl(input.stay.bookingId),
    googleUrl: googleCalendarUrl(input),
    outlookUrl: outlookCalendarUrl(input),
  };
}

/**
 * The pre-composed `{{ical}}` block for the booking-confirmed body: complete
 * lines the admin body editor can place but not reformat, per the
 * email-messages guide's block-token convention. Never empty — every
 * confirmed booking has dates — so the token needs no OPTIONAL declaration.
 */
export function bookingAddToCalendarBlock(links: BookingCalendarLinks): string {
  return [
    "Add this stay to your calendar:",
    `Calendar file (.ics): ${links.icsUrl}`,
    `Google Calendar: ${links.googleUrl}`,
    `Outlook: ${links.outlookUrl}`,
  ].join("\n");
}
