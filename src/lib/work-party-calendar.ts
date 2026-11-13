/**
 * Keeping a work party's Events Calendar entries in step with it (fork #118).
 *
 * The rows themselves are written only by `replaceWorkPartyCalendarEvents` in
 * `calendar-service.ts`; this module decides WHEN and WHAT:
 *
 * - **Create:** a new work party goes on the calendar when the Events Calendar
 *   module is on, and not otherwise.
 * - **Edit:** a work party that already has entries has them regenerated from
 *   its new name, dates, description and lodge, whatever the module state — an
 *   entry that exists must never show stale dates. One without entries (made
 *   before this feature, or while the calendar was off) is left alone, so a
 *   club that typed it on the calendar by hand does not get a duplicate.
 * - **"Add to calendar":** the officer's explicit link for such a work party;
 *   refused while the module is off.
 * - **Delete:** its entries go with it.
 * - **Deactivate / reactivate:** nothing is written. The calendar readers hide
 *   an inactive work party's entries (`VISIBLE_CALENDAR_EVENT_WHERE`), so
 *   reactivating shows them again unchanged.
 *
 * Dates come from the work party's date-only columns through the club-time
 * kernel — `calendarDateOfDateOnlyInstant` then `eachCalendarDate` over the
 * inclusive window — never by hand (INV-DATE, INV-CONFIG-002).
 */
import {
  addCalendarDays,
  calendarDateOfDateOnlyInstant,
  eachCalendarDate,
  type CalendarDate,
} from "@/lib/club-time";
import {
  replaceWorkPartyCalendarEvents,
  type WorkPartyCalendarEntry,
} from "@/lib/calendar-service";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

export interface WorkPartyCalendarSource {
  id: string;
  name: string;
  description: string | null;
  startDate: Date;
  endDate: Date;
  lodge?: { name: string } | null;
}

/** Each club day of the inclusive window, first night to last night. */
export function workPartyCalendarDays(source: {
  startDate: Date;
  endDate: Date;
}): CalendarDate[] {
  const first = calendarDateOfDateOnlyInstant(source.startDate);
  const last = calendarDateOfDateOnlyInstant(source.endDate);
  return eachCalendarDate(first, addCalendarDays(last, 1));
}

export function workPartyCalendarEntry(
  source: WorkPartyCalendarSource,
): WorkPartyCalendarEntry {
  return {
    title: `Work party: ${source.name}`,
    location: source.lodge?.name ?? null,
    details: source.description,
    days: workPartyCalendarDays(source),
  };
}

/** Whether any calendar entry is linked to this work party. */
export async function workPartyHasCalendarEntries(
  workPartyEventId: string,
): Promise<boolean> {
  const linked = await prisma.calendarEvent.findFirst({
    where: { workPartyEventId },
    select: { id: true },
  });
  return linked !== null;
}

/** The message an officer sees when the work party saved but its calendar did not. */
export const WORK_PARTY_CALENDAR_SYNC_FAILED =
  "The work party was saved, but its calendar entries could not be updated. Use Add to calendar to try again.";

/**
 * Run a calendar write after the work party itself has been saved. The work
 * party is the record that matters (it carries the discount); a calendar
 * failure is logged and reported back rather than turning a saved work party
 * into a 500 the officer would retry.
 */
async function afterWorkPartySaved(
  workPartyEventId: string,
  write: () => Promise<unknown>,
): Promise<string | null> {
  try {
    await write();
    return null;
  } catch (err) {
    logger.error(
      { err, workPartyEventId },
      "Work party calendar sync failed",
    );
    return WORK_PARTY_CALENDAR_SYNC_FAILED;
  }
}

/** On create: add the entries when the Events Calendar module is on. */
export async function syncCreatedWorkPartyCalendar(
  source: WorkPartyCalendarSource,
  actorId: string,
): Promise<string | null> {
  const modules = await loadEffectiveModuleFlags();
  if (!modules.eventsCalendar) return null;
  return afterWorkPartySaved(source.id, () =>
    replaceWorkPartyCalendarEvents(
      source.id,
      workPartyCalendarEntry(source),
      actorId,
    ),
  );
}

/** On edit: regenerate the entries a linked work party already has. */
export async function syncUpdatedWorkPartyCalendar(
  source: WorkPartyCalendarSource,
  actorId: string,
): Promise<string | null> {
  return afterWorkPartySaved(source.id, async () => {
    if (!(await workPartyHasCalendarEntries(source.id))) return;
    await replaceWorkPartyCalendarEvents(
      source.id,
      workPartyCalendarEntry(source),
      actorId,
    );
  });
}

/** Before delete: remove the entries (and their series row). */
export async function removeWorkPartyCalendar(
  workPartyEventId: string,
  actorId: string,
): Promise<void> {
  await replaceWorkPartyCalendarEvents(workPartyEventId, null, actorId);
}
