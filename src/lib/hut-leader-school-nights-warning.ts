import type { Prisma } from "@prisma/client";
import logger from "@/lib/logger";
import {
  findSchoolNightsShiftDoesNotCover,
  type HutLeaderNightCoverReader,
  type HutLeaderShift,
} from "@/lib/hut-leader-night-cover";

/**
 * The hut-leaders page's school-nights advisory (#3821), one home for the
 * create (`POST /api/admin/hut-leaders`) and the edit (`PUT .../[id]`).
 *
 * A lodge may not accept this kind of leader on a school group's nights
 * (#3819), and then those nights stay uncovered even though the row claims
 * them. The row is saved either way; this only tells the officer. Asked AFTER
 * the write commits, of the row as it now stands, so it never holds a lock,
 * and a failed read is logged and answered with no warning rather than
 * turning a saved assignment into an error.
 */
export async function readHutLeaderSchoolNightsWarning(
  reader: HutLeaderNightCoverReader,
  shift: HutLeaderShift & { lodgeId: string },
): Promise<string | null> {
  try {
    const nights = await findSchoolNightsShiftDoesNotCover(reader, shift);
    if (nights.length === 0) return null;
    const one = nights.length === 1;
    return `${one ? "One of these nights is" : `${nights.length} of these nights are`} a school group's (from ${nights[0]}), and this lodge does not accept this kind of hut leader for school bookings, so ${one ? "it stays" : "they stay"} without a hut leader who counts. Add a leader the lodge accepts for ${one ? "that night" : "those nights"}, or change who can be hut leader for school bookings on the lodge's settings.`;
  } catch (err) {
    logger.error({ err, assignmentId: shift.id }, "Failed to check school nights for a hut leader assignment");
    return null;
  }
}

/**
 * The edit's form: re-read the assignment as it now stands, after the PUT's
 * transaction commits, and ask {@link readHutLeaderSchoolNightsWarning} of it.
 * An edit can move a row onto school nights or change its kind (the custodian
 * tick, a held bed) as surely as a create. A failed read is no warning, never
 * a failed save.
 */
export async function readSavedHutLeaderSchoolNightsWarning(
  db: Pick<
    Prisma.TransactionClient,
    "hutLeaderAssignment" | "bookingGuest" | "booking" | "lodgeSettings"
  >,
  assignmentId: string,
): Promise<string | null> {
  try {
    const saved = await db.hutLeaderAssignment.findUnique({ where: { id: assignmentId } });
    return saved ? await readHutLeaderSchoolNightsWarning(db, saved) : null;
  } catch (err) {
    logger.error({ err, assignmentId }, "Failed to re-read an edited hut leader assignment");
    return null;
  }
}
