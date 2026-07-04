import {
  choreRosterTemplate,
  hutLeaderAssignmentTemplate,
} from "../email-templates";
import {
  CLUB_LODGE_NAME,
  CLUB_NAME,
} from "@/config/club-identity";
import { formatNZDate } from "../nzst-date";
import { sendEmail } from "./core";

export async function sendChoreRosterEmail(
  email: string,
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string,
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
    subject: `Your ${CLUB_NAME} hut leader assignment`,
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
