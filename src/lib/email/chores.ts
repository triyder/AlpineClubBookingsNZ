import {
  choreRosterTemplate,
  hutLeaderAssignmentTemplate,
} from "../email-templates";
import {
  CLUB_HUT_LEADER_LABEL,
  CLUB_LODGE_NAME,
  CLUB_NAME,
} from "@/config/club-identity";
import { formatNZDate } from "../nzst-date";
import { sendEmail } from "./core";

// #1285: the "Chore Roster" notification preference is honored by the caller
// (`admin-roster-service.ts` via `shouldSendChoreRoster`), before a chore
// token is created — mirroring how check-in reminders are gated in their cron
// caller. This sender stays a pure transport so it never double-gates.
export async function sendChoreRosterEmail(
  email: string,
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  const formattedDate = new Date(date + "T00:00:00").toLocaleDateString(
    "en-NZ",
    {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    },
  );

  await sendEmail({
    to: email,
    subject: `Your chore roster for ${formattedDate} - ${CLUB_LODGE_NAME}`,
    html: choreRosterTemplate(guestName, date, chores, choreLink),
    templateName: "chore-roster",
    templateData: {
      guestName,
      formattedDate,
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
      choreLink: choreLink ?? "",
    },
    lodgeId,
  });
}

export async function sendHutLeaderAssignmentEmail(params: {
  email: string;
  firstName: string;
  startDate: Date;
  endDate: Date;
  pin: string;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your ${CLUB_NAME} ${CLUB_HUT_LEADER_LABEL.toLowerCase()} assignment`,
    html: hutLeaderAssignmentTemplate(params),
    templateName: "hut-leader-assignment",
    templateData: {
      firstName: params.firstName,
      startDate: formatNZDate(params.startDate),
      endDate: formatNZDate(params.endDate),
      pin: params.pin,
    },
  });
}
