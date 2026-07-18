import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { allocateChores, ChoreTemplateInput, GuestInput, ChoreHistoryEntry } from "@/lib/chore-allocator"
import { getLodgeCapacity, FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity"
import { getBookingGuestDisplayAgeTier } from "@/lib/booking-guests"
import { sendChoreRosterEmail, shouldSendChoreRoster } from "@/lib/email"
import { createGuestChoreToken } from "@/lib/guest-chore-token"
import { getEffectiveEmail } from "@/lib/member-utils"
import { addDaysDateOnly, formatDateOnly } from "@/lib/date-only"
import { getActiveGuestsForNight, getGuestStayEnd, getGuestStayStart } from "@/lib/booking-guest-stay-ranges"
import { validateRosterAllocationsForDate } from "@/lib/lodge-date-scoping"
import { lodgeNullTolerantScope } from "@/lib/lodges"
import { z } from "zod"
import logger from "@/lib/logger"
import { logAudit } from "@/lib/audit"
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status"

type JsonRouteResult = {
  body: unknown
  init?: ResponseInit
}

function jsonResult(body: unknown, init?: ResponseInit): JsonRouteResult {
  return { body, init }
}

export const rosterActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reassign"),
    assignmentId: z.string().min(1),
    bookingGuestId: z.string().min(1),
  }),
  z.object({
    action: z.literal("add"),
    choreTemplateId: z.string().min(1),
    bookingGuestId: z.string().min(1),
    bookingId: z.string().min(1),
  }),
  z.object({
    action: z.literal("remove"),
    assignmentId: z.string().min(1),
  }),
  z.object({
    action: z.literal("regenerate"),
    includeNonEssential: z.boolean().optional(),
    overwriteConfirmed: z.boolean().optional(),
  }),
  z.object({ action: z.literal("confirm") }),
  z.object({ action: z.literal("email"), notifyMember: z.boolean().optional() }),
])

export type RosterActionInput = z.infer<typeof rosterActionSchema>

async function getGuestsForDate(date: Date, lodgeId: string): Promise<GuestInput[]> {
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: date },
      checkOut: { gt: date },
      ...lodgeNullTolerantScope(lodgeId),
      guests: {
        some: {
          stayStart: { lte: date },
          stayEnd: { gt: date },
        },
      },
    },
    include: {
      guests: {
        where: {
          stayStart: { lte: date },
          stayEnd: { gt: date },
        },
        include: {
          member: {
            select: { ageTier: true },
          },
        },
      },
    },
  })

  const nextDay = addDaysDateOnly(date, 1)

  return bookings.flatMap((b) =>
    getActiveGuestsForNight(b.guests, date, b).map((g) => ({
      id: g.id,
      bookingId: b.id,
      firstName: g.firstName,
      lastName: g.lastName,
      ageTier: getBookingGuestDisplayAgeTier(g),
      isArriving: getGuestStayStart(g, b).getTime() === date.getTime(),
      isDeparting: getGuestStayEnd(g, b).getTime() === nextDay.getTime(),
    }))
  )
}

async function buildSuggestedAllocations(
  tx: Prisma.TransactionClient,
  date: Date,
  guests: GuestInput[],
  includeNonEssential: boolean | undefined,
  lodgeId: string
) {
  const choreTemplates = await tx.choreTemplate.findMany({
    where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
    orderBy: { sortOrder: "asc" },
  })

  const templateInputs: ChoreTemplateInput[] = choreTemplates.map((t) => ({
    id: t.id,
    name: t.name,
    recommendedPeopleMin: t.recommendedPeopleMin,
    recommendedPeopleMax: t.recommendedPeopleMax,
    isEssential: t.isEssential,
    ageRestriction: t.ageRestriction,
    minAge: t.minAge,
    sortOrder: t.sortOrder,
    timeOfDay: t.timeOfDay,
    frequencyMode: t.frequencyMode,
    frequencyDays: t.frequencyDays,
    frequencyDaysOfWeek: t.frequencyDaysOfWeek,
  }))

  const lookbackDate = addDaysDateOnly(date, -4)

  const historyRecords = await tx.choreAssignment.findMany({
    where: {
      date: { gte: lookbackDate, lt: date },
      bookingGuestId: { in: guests.map((g) => g.id) },
    },
  })

  const history: ChoreHistoryEntry[] = historyRecords
    .filter((h) => h.bookingGuestId !== null)
    .map((h) => ({
      guestId: h.bookingGuestId!,
      choreTemplateId: h.choreTemplateId,
      date: h.date,
    }))

  const lastRosteredRecords = await tx.choreAssignment.groupBy({
    by: ["choreTemplateId"],
    where: { date: { lt: date } },
    _max: { date: true },
  })
  const choreLastRosteredDates = new Map<string, Date>()
  for (const rec of lastRosteredRecords) {
    if (rec._max.date) {
      choreLastRosteredDates.set(rec.choreTemplateId, rec._max.date)
    }
  }

  // #2021 (#1982/#2013 residual): scale per-chore people-counts by this lodge's
  // real resolved sleeping capacity (lodge-scoped), not the fixed display
  // constant. Resolved within the roster transaction so it sees the same client;
  // if the capacity read fails or resolves to a non-positive value, keep the
  // constant fallback (allocateChores' own default) so housekeeping never breaks.
  let capacity = FALLBACK_LODGE_CAPACITY
  try {
    const resolved = await getLodgeCapacity(
      lodgeId,
      tx as unknown as Parameters<typeof getLodgeCapacity>[1],
    )
    if (resolved > 0) capacity = resolved
  } catch (err) {
    logger.warn(
      { err, lodgeId },
      "Falling back to default lodge capacity for chore people-count scaling",
    )
  }

  const options: {
    includeNonEssential?: boolean
    choreLastRosteredDates?: Map<string, Date>
    currentDate?: Date
    capacity?: number
  } = { choreLastRosteredDates, currentDate: date, capacity }

  if (includeNonEssential !== undefined) {
    options.includeNonEssential = includeNonEssential
  }

  return allocateChores(templateInputs, guests, history, options)
}

async function lockRosterDate(tx: Prisma.TransactionClient, date: Date) {
  const lockKey = `roster:${formatDateOnly(date)}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`
}

export async function getAdminRosterForDate(params: {
  date: Date
  dateString: string
  regenerate: boolean
  includeNonEssential?: boolean
  lodgeId: string
}): Promise<JsonRouteResult> {
  const { date, dateString: dateStr, regenerate, includeNonEssential, lodgeId } = params
  const guests = await getGuestsForDate(date, lodgeId)

  // Wrap check + create in a transaction to prevent concurrent duplicate assignments
  const existing = await prisma.$transaction(async (tx) => {
    await lockRosterDate(tx, date)

    let current = await tx.choreAssignment.findMany({
      where: { date },
      include: {
        choreTemplate: true,
        bookingGuest: {
          include: {
            member: {
              select: { ageTier: true },
            },
          },
        },
      },
    })

    // If regenerating, delete SUGGESTED assignments (keep CONFIRMED/COMPLETED)
    if (regenerate) {
      await tx.choreAssignment.deleteMany({
        where: { date, status: "SUGGESTED" },
      })
      current = current.filter((a) => a.status !== "SUGGESTED")
    }

    // If no assignments or only non-SUGGESTED remain after regeneration, auto-suggest
    const hasSuggested = current.some((a) => a.status === "SUGGESTED")
    const hasConfirmed = current.some((a) => a.status === "CONFIRMED" || a.status === "COMPLETED")

    if (!hasSuggested && !hasConfirmed) {
      const allocations = await buildSuggestedAllocations(
        tx,
        date,
        guests,
        includeNonEssential,
        lodgeId
      )

      // Save allocations
      if (allocations.length > 0) {
        await tx.choreAssignment.createMany({
          data: allocations.map((a) => ({
            choreTemplateId: a.choreTemplateId,
            bookingId: a.bookingId,
            bookingGuestId: a.bookingGuestId,
            date,
            status: "SUGGESTED",
          })),
        })
      }
    }

    // Re-fetch after potential creation
    return tx.choreAssignment.findMany({
      where: { date },
      include: {
        choreTemplate: true,
        bookingGuest: {
          include: {
            member: {
              select: { ageTier: true },
            },
          },
        },
      },
    })
  })

  // Get all active chore templates for the UI
  const allTemplates = await prisma.choreTemplate.findMany({
    where: { active: true, ...lodgeNullTolerantScope(lodgeId) },
    orderBy: { sortOrder: "asc" },
  })

  // Get 4-day history for each guest (for display)
  const lookbackDate = addDaysDateOnly(date, -4)

  const guestHistory = await prisma.choreAssignment.findMany({
    where: {
      date: { gte: lookbackDate, lt: date },
      bookingGuestId: { in: guests.map((g) => g.id) },
    },
    include: { choreTemplate: true },
    orderBy: { date: "desc" },
  })

  // Group history by guest
  const historyByGuest: Record<string, Array<{ date: string; choreName: string }>> = {}
  for (const h of guestHistory) {
    if (!h.bookingGuestId) continue
    if (!historyByGuest[h.bookingGuestId]) {
      historyByGuest[h.bookingGuestId] = []
    }
    historyByGuest[h.bookingGuestId].push({
      date: formatDateOnly(h.date),
      choreName: h.choreTemplate.name,
    })
  }

  return jsonResult({
    date: dateStr,
    guests,
    assignments: existing.map((a) => ({
      id: a.id,
      choreTemplateId: a.choreTemplateId,
      choreTemplateName: a.choreTemplate.name,
      choreDescription: a.choreTemplate.description,
      choreSortOrder: a.choreTemplate.sortOrder,
      bookingGuestId: a.bookingGuestId,
      guestName: a.bookingGuest
        ? `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`
        : null,
      guestAgeTier: a.bookingGuest ? getBookingGuestDisplayAgeTier(a.bookingGuest) : null,
      bookingId: a.bookingId,
      status: a.status,
    })),
    templates: allTemplates,
    guestHistory: historyByGuest,
    guestCount: guests.length,
  })
}

export async function updateAdminRosterForDate(params: {
  date: Date
  dateString: string
  data: RosterActionInput
  lodgeId: string
  adminMemberId?: string
}): Promise<JsonRouteResult> {
  const { date, dateString: dateStr, data, lodgeId, adminMemberId } = params
  try {
  switch (data.action) {
    case "reassign": {
      const assignment = await prisma.choreAssignment.findUnique({
        where: { id: data.assignmentId },
        select: { bookingId: true },
      })
      if (!assignment) {
        return jsonResult({ error: "Assignment not found" }, { status: 404 })
      }
      const allocationIsValid = await validateRosterAllocationsForDate(
        [{ bookingGuestId: data.bookingGuestId, bookingId: assignment.bookingId }],
        date
      )
      if (!allocationIsValid) {
        return jsonResult(
          { error: "Assignment must reference a guest staying on this date" },
          { status: 400 }
        )
      }
      await prisma.choreAssignment.update({
        where: { id: data.assignmentId },
        data: { bookingGuestId: data.bookingGuestId },
      })
      break
    }
    case "add": {
      const allocationIsValid = await validateRosterAllocationsForDate(
        [{ bookingGuestId: data.bookingGuestId, bookingId: data.bookingId }],
        date
      )
      if (!allocationIsValid) {
        return jsonResult(
          { error: "Assignment must reference a guest staying on this date" },
          { status: 400 }
        )
      }
      await prisma.choreAssignment.create({
        data: {
          choreTemplateId: data.choreTemplateId,
          bookingId: data.bookingId,
          bookingGuestId: data.bookingGuestId,
          date,
          status: "SUGGESTED",
        },
      })
      break
    }
    case "remove": {
      await prisma.choreAssignment.delete({ where: { id: data.assignmentId } })
      break
    }
    case "regenerate": {
      const regenerateResult = await prisma.$transaction(async (tx) => {
        await lockRosterDate(tx, date)

        const currentAssignments = await tx.choreAssignment.findMany({
          where: { date },
          select: { status: true },
        })

        const hasConfirmed = currentAssignments.some(
          (assignment) =>
            assignment.status === "CONFIRMED" || assignment.status === "COMPLETED"
        )

        if (hasConfirmed && !data.overwriteConfirmed) {
          return { conflict: true as const }
        }

        const guests = await getGuestsForDate(date, lodgeId)
        const deleteWhere = hasConfirmed
          ? { date }
          : { date, status: "SUGGESTED" as const }

        await tx.choreAssignment.deleteMany({ where: deleteWhere })

        const allocations = await buildSuggestedAllocations(
          tx,
          date,
          guests,
          data.includeNonEssential,
          lodgeId
        )

        if (allocations.length > 0) {
          await tx.choreAssignment.createMany({
            data: allocations.map((allocation) => ({
              choreTemplateId: allocation.choreTemplateId,
              bookingId: allocation.bookingId,
              bookingGuestId: allocation.bookingGuestId,
              date,
              status: "SUGGESTED",
            })),
          })
        }

        return { conflict: false as const }
      })

      if (regenerateResult.conflict) {
        return jsonResult(
          {
            error:
              "Roster already confirmed. Confirm overwrite to regenerate it.",
          },
          { status: 409 }
        )
      }
      break
    }
    case "confirm": {
      await prisma.choreAssignment.updateMany({
        where: { date, status: "SUGGESTED" },
        data: { status: "CONFIRMED" },
      })
      break
    }
    case "email": {
      // #1785 (#1769b sweep): the admin can suppress the whole roster send.
      // SUPPRESS (notifyMember === false) short-circuits BEFORE any token work
      // or email — no token deletion, no new tokens, no sends — so previously
      // emailed chore links stay valid. Only the suppression is audited; the
      // default/true notify path writes no audit field (mirrors #1769a).
      if (data.notifyMember === false) {
        logAudit({
          action: "ADMIN_CHORE_ROSTER_EMAIL_SUPPRESSED",
          memberId: adminMemberId,
          category: "communication",
          severity: "info",
          summary: "Admin suppressed the chore-roster email send",
          details: JSON.stringify({ date: dateStr, lodgeId, notifyMember: false }),
          metadata: { date: dateStr, lodgeId, notifyMember: false },
        })
        return jsonResult({
          success: true,
          suppressed: true,
          sent: 0,
          skipped: 0,
          failed: 0,
          failures: [],
        })
      }

      // Send roster email to all guests for this date
      const assignments = await prisma.choreAssignment.findMany({
        where: { date },
        include: {
          choreTemplate: true,
          bookingGuest: {
            include: {
              member: {
                select: {
                  id: true,
                  email: true,
                  inheritEmailFromId: true,
                  inheritEmailFrom: { select: { email: true } },
                },
              },
            },
          },
        },
      })

      // Group assignments by guest, resolving effective email for dependents
      const byGuest = new Map<string, {
        email: string | null
        // #1285: the guest's own member id (null for non-member guests) plus the
        // member they inherit their email from (if any), so the roster send can
        // resolve the effective choreRoster preference (Option C hybrid).
        memberId: string | null
        inheritEmailFromId: string | null
        name: string
        chores: Array<{ name: string; description: string | null }>
      }>()

      for (const a of assignments) {
        if (!a.bookingGuest) continue
        const guestId = a.bookingGuest.id
        if (!byGuest.has(guestId)) {
          const effectiveEmail = a.bookingGuest.member
            ? await getEffectiveEmail(a.bookingGuest.member)
            : null
          byGuest.set(guestId, {
            email: effectiveEmail,
            memberId: a.bookingGuest.member?.id ?? null,
            inheritEmailFromId: a.bookingGuest.member?.inheritEmailFromId ?? null,
            name: `${a.bookingGuest.firstName} ${a.bookingGuest.lastName}`,
            chores: [],
          })
        }
        byGuest.get(guestId)!.chores.push({
          name: a.choreTemplate.name,
          description: a.choreTemplate.description,
        })
      }

      // Generate per-guest chore tokens and send emails
      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000"
      const emailPromises: Promise<{
        guestId: string
        name: string
        email: string
      }>[] = []
      let skipped = 0
      for (const [guestId, guest] of byGuest) {
        if (!guest.email) continue
        // #1285 Option C (hybrid): resolve the guest's effective chore-roster
        // preference BEFORE creating a token, so an opted-out recipient is
        // suppressed without leaving an orphaned GuestChoreToken behind.
        const wantsRoster = await shouldSendChoreRoster(
          guest.memberId,
          guest.inheritEmailFromId,
        )
        if (!wantsRoster) {
          skipped++
          logger.debug(
            { guestId, memberId: guest.memberId, date: dateStr },
            "Skipped chore roster email — recipient opted out of the choreRoster category",
          )
          continue
        }
        const recipientEmail = guest.email
        emailPromises.push(
          (async () => {
            // Delete old tokens for this guest+date to prevent duplicates
            await prisma.guestChoreToken.deleteMany({
              where: { bookingGuestId: guestId, date },
            })
            const token = await createGuestChoreToken(guestId, date)
            const choreLink = `${baseUrl}/chores/${token}`
            await sendChoreRosterEmail(
              recipientEmail,
              guest.name,
              dateStr,
              guest.chores,
              choreLink,
              lodgeId,
            )
            return {
              guestId,
              name: guest.name,
              email: recipientEmail,
            }
          })()
        )
      }

      const results = await Promise.allSettled(emailPromises)
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => ({
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        }))

      return jsonResult({
        success: true,
        partialFailure: failures.length > 0,
        sent: results.filter((result) => result.status === "fulfilled").length,
        failed: failures.length,
        // #1285: guests suppressed by their (or their primary's) choreRoster
        // opt-out. Surfaced so the admin isn't confused when sent < guest count.
        skipped,
        failures,
      })
    }
  }
  } catch (err) {
    logger.error({ err }, "Error processing roster action")
    return jsonResult({ error: "Failed to process roster action" }, { status: 500 })
  }

  return jsonResult({ success: true })
}
