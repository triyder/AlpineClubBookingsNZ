import { randomBytes } from "crypto";
import { hash } from "bcryptjs";
import {
  AgeTier,
  BookingRequestPricingMode,
  BookingRequestQuoteStatus,
  BookingRequestStatus,
  BookingRequestType,
  BookingStatus,
  Prisma,
  SchoolCateringOption,
  SchoolCateringPreference,
} from "@prisma/client";
import { z } from "zod";
import { hashActionToken, issueActionToken } from "@/lib/action-tokens";
import { logAudit } from "@/lib/audit";
import {
  approveBookingRequest,
  BookingRequestError,
  getBookingRequestSettings,
  linkedGuestMemberMap,
  parseBookingRequestGuests,
  splitPriceAcrossGuests,
  type BookingRequestLinkedGuestMember,
} from "@/lib/booking-request";
import { assertNoBookingMemberNightConflicts } from "@/lib/booking-member-night-conflicts";
import { checkCapacityForGuestRanges } from "@/lib/capacity";
import { sendBookingRequestQuoteEmail } from "@/lib/email";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { approveSchoolBookingRequest } from "@/lib/school-booking-request";

const DAY_MS = 24 * 60 * 60 * 1000;
const quoteableStatuses = [
  BookingRequestStatus.VERIFIED,
  BookingRequestStatus.PRICED,
  BookingRequestStatus.QUOTED,
  BookingRequestStatus.QUOTE_SENT,
  BookingRequestStatus.QUERY_PENDING,
  BookingRequestStatus.MODIFICATION_REQUESTED,
] as const;

const holdableStatuses = [
  BookingRequestStatus.VERIFIED,
  BookingRequestStatus.PRICED,
  BookingRequestStatus.QUOTED,
  BookingRequestStatus.QUOTE_SENT,
  BookingRequestStatus.QUERY_PENDING,
  BookingRequestStatus.MODIFICATION_REQUESTED,
] as const;

export class BookingRequestQuoteError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BookingRequestQuoteError";
    this.status = status;
  }
}

const bookingRequestGuestNightRateSchema = z.object({
  ageTier: z.enum(AgeTier),
  isMember: z.boolean(),
  rateCents: z.number().int().min(0),
});

const bookingRequestQuoteOptionInputSchema = z.object({
  id: z.string().min(1).max(40).optional(),
  cateringOption: z.enum(SchoolCateringOption).optional().nullable(),
  totalCents: z.number().int().min(0).optional(),
  guestNightRates: z.array(bookingRequestGuestNightRateSchema).optional(),
});

export const bookingRequestQuoteInputSchema = z.object({
  pricingMode: z.enum(BookingRequestPricingMode),
  options: z.array(bookingRequestQuoteOptionInputSchema).min(1).max(2),
  message: z.string().max(2000).optional().nullable(),
  linkedGuestMembers: z
    .array(
      z.object({
        guestIndex: z.number().int().min(0),
        memberId: z.string().min(1),
      })
    )
    .optional(),
});

type BookingRequestQuoteInput = z.infer<
  typeof bookingRequestQuoteInputSchema
>;

interface NormalizedQuoteOption {
  id: string;
  label: string;
  cateringOption: SchoolCateringOption | null;
  totalCents: number;
  pricingMode: BookingRequestPricingMode;
  guestNightRates?: Array<{
    ageTier: AgeTier;
    isMember: boolean;
    rateCents: number;
  }>;
  guestBreakdown: Array<{
    guestIndex: number;
    firstName: string;
    lastName: string;
    ageTier: AgeTier;
    isMember: boolean;
    memberId: string | null;
    nightCount: number;
    rateCents: number | null;
    totalCents: number;
  }>;
}

const quoteOptionsSchema = z.array(
  z.object({
    id: z.string(),
    label: z.string(),
    cateringOption: z.enum(SchoolCateringOption).nullable(),
    totalCents: z.number().int().min(0),
    pricingMode: z.enum(BookingRequestPricingMode),
    guestNightRates: z.array(bookingRequestGuestNightRateSchema).optional(),
    guestBreakdown: z.array(
      z.object({
        guestIndex: z.number().int().min(0),
        firstName: z.string(),
        lastName: z.string(),
        ageTier: z.enum(AgeTier),
        isMember: z.boolean(),
        memberId: z.string().nullable(),
        nightCount: z.number().int().min(0),
        rateCents: z.number().int().min(0).nullable(),
        totalCents: z.number().int().min(0),
      })
    ),
  })
);

function cleanNullableString(value?: string | null) {
  const trimmed = value?.replace(/[\r\n]/g, " ").trim() ?? "";
  return trimmed || null;
}

function getNightCount(checkIn: Date, checkOut: Date) {
  return Math.max(0, Math.ceil((checkOut.getTime() - checkIn.getTime()) / DAY_MS));
}

function rateKey(ageTier: AgeTier, isMember: boolean) {
  return `${ageTier}:${isMember ? "member" : "non-member"}`;
}

function getAllowedSchoolCateringOptions(
  preference: SchoolCateringPreference | null
) {
  if (preference === SchoolCateringPreference.CATERED) {
    return new Set<SchoolCateringOption>([SchoolCateringOption.CATERED]);
  }
  if (preference === SchoolCateringPreference.NON_CATERED) {
    return new Set<SchoolCateringOption>([SchoolCateringOption.NON_CATERED]);
  }
  return new Set<SchoolCateringOption>([
    SchoolCateringOption.CATERED,
    SchoolCateringOption.NON_CATERED,
  ]);
}

function optionLabel(option: SchoolCateringOption | null) {
  if (option === SchoolCateringOption.CATERED) return "Catered";
  if (option === SchoolCateringOption.NON_CATERED) return "Non-catered";
  return "Quote";
}

export function parseBookingRequestQuoteOptions(
  raw: unknown
): NormalizedQuoteOption[] {
  const parsed = quoteOptionsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BookingRequestQuoteError("Stored booking request quote is invalid", 500);
  }
  return parsed.data;
}

function normalizeLinkedGuestMembers(
  links: BookingRequestLinkedGuestMember[] | undefined,
  guestCount: number
) {
  const byGuest = new Map<number, string>();
  for (const link of links ?? []) {
    if (link.guestIndex >= guestCount) {
      throw new BookingRequestQuoteError("Linked member guest index is invalid", 422);
    }
    byGuest.set(link.guestIndex, link.memberId);
  }
  return Array.from(byGuest.entries()).map(([guestIndex, memberId]) => ({
    guestIndex,
    memberId,
  }));
}

async function assertLinkedMembersExist(links: BookingRequestLinkedGuestMember[]) {
  const ids = Array.from(new Set(links.map((link) => link.memberId)));
  if (ids.length === 0) return;

  const members = await prisma.member.findMany({
    where: {
      id: { in: ids },
      active: true,
      archivedAt: null,
    },
    select: { id: true },
  });
  const found = new Set(members.map((member) => member.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BookingRequestQuoteError("One or more linked members were not found", 422);
  }
}

function normalizeQuoteOptions(input: {
  request: {
    type: BookingRequestType;
    cateringPreference: SchoolCateringPreference | null;
    checkIn: Date;
    checkOut: Date;
    guests: Prisma.JsonValue;
  };
  pricingMode: BookingRequestPricingMode;
  options: BookingRequestQuoteInput["options"];
  linkedGuestMembers: BookingRequestLinkedGuestMember[];
}): NormalizedQuoteOption[] {
  const guests = parseBookingRequestGuests(input.request.guests);
  const nightCount = getNightCount(input.request.checkIn, input.request.checkOut);
  const linkedMembers = new Map(
    input.linkedGuestMembers.map((link) => [link.guestIndex, link.memberId])
  );
  const isSchool = input.request.type === BookingRequestType.SCHOOL;
  const allowedSchoolOptions = getAllowedSchoolCateringOptions(
    input.request.cateringPreference
  );

  const seenOptionIds = new Set<string>();

  return input.options.map((option, optionIndex) => {
    const cateringOption = isSchool ? option.cateringOption ?? null : null;
    if (isSchool) {
      if (!cateringOption) {
        throw new BookingRequestQuoteError(
          "School quotes must identify catered or non-catered options",
          422
        );
      }
      if (!allowedSchoolOptions.has(cateringOption)) {
        throw new BookingRequestQuoteError(
          "Quote option does not match the school's catering preference",
          422
        );
      }
    } else if (option.cateringOption) {
      throw new BookingRequestQuoteError(
        "Catering options only apply to school booking requests",
        422
      );
    }

    const id = isSchool
      ? cateringOption!
      : option.id?.trim() || (optionIndex === 0 ? "STANDARD" : `OPTION_${optionIndex + 1}`);
    if (seenOptionIds.has(id)) {
      throw new BookingRequestQuoteError("Quote option ids must be unique", 422);
    }
    seenOptionIds.add(id);

    if (input.pricingMode === BookingRequestPricingMode.OVERALL_TOTAL) {
      if (option.totalCents == null) {
        throw new BookingRequestQuoteError("Overall quote options require a total", 422);
      }
      const split = splitPriceAcrossGuests(option.totalCents, guests.length);
      return {
        id,
        label: optionLabel(cateringOption),
        cateringOption,
        totalCents: option.totalCents,
        pricingMode: input.pricingMode,
        guestBreakdown: guests.map((guest, guestIndex) => {
          const memberId = linkedMembers.get(guestIndex) ?? null;
          return {
            guestIndex,
            firstName: guest.firstName,
            lastName: guest.lastName,
            ageTier: guest.ageTier,
            isMember: Boolean(memberId),
            memberId,
            nightCount,
            rateCents: null,
            totalCents: split[guestIndex] ?? 0,
          };
        }),
      };
    }

    const rates = option.guestNightRates ?? [];
    if (rates.length === 0) {
      throw new BookingRequestQuoteError(
        "Per guest-night quotes require age-tier/member rates",
        422
      );
    }
    const rateByKey = new Map(
      rates.map((rate) => [rateKey(rate.ageTier, rate.isMember), rate.rateCents])
    );
    const guestBreakdown = guests.map((guest, guestIndex) => {
      const memberId = linkedMembers.get(guestIndex) ?? null;
      const isMember = Boolean(memberId);
      const rateCents = rateByKey.get(rateKey(guest.ageTier, isMember));
      if (rateCents == null) {
        throw new BookingRequestQuoteError(
          `Missing ${guest.ageTier} ${isMember ? "member" : "non-member"} rate`,
          422
        );
      }
      return {
        guestIndex,
        firstName: guest.firstName,
        lastName: guest.lastName,
        ageTier: guest.ageTier,
        isMember,
        memberId,
        nightCount,
        rateCents,
        totalCents: rateCents * nightCount,
      };
    });

    return {
      id,
      label: optionLabel(cateringOption),
      cateringOption,
      totalCents: guestBreakdown.reduce((sum, guest) => sum + guest.totalCents, 0),
      pricingMode: input.pricingMode,
      guestNightRates: rates,
      guestBreakdown,
    };
  });
}

function firstQuoteOption(options: NormalizedQuoteOption[], optionId?: string | null) {
  if (!optionId) return options[0];
  return options.find((option) => option.id === optionId) ?? null;
}

export async function createBookingRequestQuote(input: {
  requestId: string;
  adminMemberId: string;
  quote: BookingRequestQuoteInput;
}) {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  if (!quoteableStatuses.includes(request.status as never)) {
    throw new BookingRequestError("This booking request cannot be quoted", 409);
  }

  const guests = parseBookingRequestGuests(request.guests);
  const linkedGuestMembers = normalizeLinkedGuestMembers(
    input.quote.linkedGuestMembers,
    guests.length
  );
  await assertLinkedMembersExist(linkedGuestMembers);

  const options = normalizeQuoteOptions({
    request,
    pricingMode: input.quote.pricingMode,
    options: input.quote.options,
    linkedGuestMembers,
  });

  const message = cleanNullableString(input.quote.message);
  const quotedAt = new Date();

  const quote = await prisma.$transaction(async (tx) => {
    const latest = await tx.bookingRequestQuote.findFirst({
      where: { bookingRequestId: request.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await tx.bookingRequestQuote.updateMany({
      where: {
        bookingRequestId: request.id,
        status: {
          in: [
            BookingRequestQuoteStatus.DRAFT,
            BookingRequestQuoteStatus.SENT,
          ],
        },
      },
      data: {
        status: BookingRequestQuoteStatus.SUPERSEDED,
        supersededAt: quotedAt,
      },
    });

    const created = await tx.bookingRequestQuote.create({
      data: {
        bookingRequestId: request.id,
        version: (latest?.version ?? 0) + 1,
        status: BookingRequestQuoteStatus.DRAFT,
        pricingMode: input.quote.pricingMode,
        options: options as unknown as Prisma.InputJsonValue,
        message,
        createdByMemberId: input.adminMemberId,
      },
    });

    await tx.bookingRequest.update({
      where: { id: request.id },
      data: {
        status: BookingRequestStatus.QUOTED,
        priceCents: options.length === 1 ? options[0].totalCents : null,
        pricedByMemberId: input.adminMemberId,
        pricedAt: quotedAt,
        linkedGuestMembers: linkedGuestMembers as unknown as Prisma.InputJsonValue,
        responseMessage: null,
        responseMessageAt: null,
      },
    });

    return created;
  });

  logAudit({
    action: "booking_request.quote_created",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: request.id,
    entityType: "BookingRequest",
    entityId: request.id,
    category: "booking",
    outcome: "success",
    summary: "Booking request quote created",
    metadata: {
      quoteId: quote.id,
      version: quote.version,
      pricingMode: input.quote.pricingMode,
      optionCount: options.length,
      totals: options.map((option) => ({
        id: option.id,
        totalCents: option.totalCents,
      })),
    },
  });

  return {
    ...quote,
    options,
  };
}

export async function sendBookingRequestQuote(input: {
  requestId: string;
  adminMemberId: string;
}) {
  const quote = await prisma.bookingRequestQuote.findFirst({
    where: {
      bookingRequestId: input.requestId,
      status: {
        in: [BookingRequestQuoteStatus.DRAFT, BookingRequestQuoteStatus.SENT],
      },
    },
    orderBy: { version: "desc" },
    include: { bookingRequest: true },
  });

  if (!quote) {
    throw new BookingRequestQuoteError("Create a quote before sending it", 409);
  }

  const options = parseBookingRequestQuoteOptions(quote.options);
  const settings = await getBookingRequestSettings();
  const ttlMs = settings.quoteResponseTtlDays * DAY_MS;
  const { token, tokenHash } = issueActionToken();
  const sentAt = new Date();
  const expiresAt = new Date(sentAt.getTime() + ttlMs);

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.bookingRequestQuote.update({
      where: { id: quote.id },
      data: {
        status: BookingRequestQuoteStatus.SENT,
        responseTokenHash: tokenHash,
        responseTokenExpiresAt: expiresAt,
        sentAt,
        reminderSentAt: null,
        createdByMemberId: quote.createdByMemberId ?? input.adminMemberId,
      },
    });

    await tx.bookingRequest.update({
      where: { id: quote.bookingRequestId },
      data: {
        status: BookingRequestStatus.QUOTE_SENT,
        reviewedByMemberId: input.adminMemberId,
        reviewedAt: sentAt,
      },
    });

    return saved;
  });

  let emailDelivered = true;
  try {
    await sendBookingRequestQuoteEmail({
      email: quote.bookingRequest.contactEmail,
      firstName: quote.bookingRequest.contactFirstName,
      token,
      checkIn: quote.bookingRequest.checkIn,
      checkOut: quote.bookingRequest.checkOut,
      guestCount: parseBookingRequestGuests(quote.bookingRequest.guests).length,
      requestType: quote.bookingRequest.type,
      schoolName: quote.bookingRequest.schoolName,
      options,
      message: quote.message,
      expiresAt,
    });
  } catch (err) {
    emailDelivered = false;
    logger.error(
      { err, bookingRequestId: quote.bookingRequestId, quoteId: quote.id },
      "Failed to send booking request quote email"
    );
  }

  logAudit({
    action: "booking_request.quote_sent",
    memberId: input.adminMemberId,
    actorMemberId: input.adminMemberId,
    targetId: quote.bookingRequestId,
    entityType: "BookingRequest",
    entityId: quote.bookingRequestId,
    category: "booking",
    outcome: emailDelivered ? "success" : "failure",
    summary: emailDelivered
      ? "Booking request quote sent"
      : "Booking request quote saved but the email could not be delivered",
    metadata: {
      quoteId: quote.id,
      version: quote.version,
      expiresAt: expiresAt.toISOString(),
      emailDelivered,
    },
  });

  return { ...updated, options, responseTokenExpiresAt: expiresAt, emailDelivered };
}

async function loadSentQuoteByToken(token: string) {
  const tokenHash = hashActionToken(token);
  const quote = await prisma.bookingRequestQuote.findUnique({
    where: { responseTokenHash: tokenHash },
    include: { bookingRequest: true },
  });

  if (!quote) {
    throw new BookingRequestQuoteError("This quote is not valid.", 404);
  }
  if (quote.status !== BookingRequestQuoteStatus.SENT) {
    // Cancelled, accepted, or superseded by a newer quote: the requester should
    // use the most recent quote email rather than this stale link.
    throw new BookingRequestQuoteError("This quote is no longer active.", 409);
  }
  if (!quote.responseTokenExpiresAt || quote.responseTokenExpiresAt < new Date()) {
    throw new BookingRequestQuoteError("This quote has expired.", 410);
  }

  return quote;
}

export async function getBookingRequestQuoteContext(token: string) {
  const quote = await loadSentQuoteByToken(token);
  const options = parseBookingRequestQuoteOptions(quote.options);
  const request = quote.bookingRequest;

  return {
    requestId: request.id,
    quoteId: quote.id,
    version: quote.version,
    status: quote.status,
    requestStatus: request.status,
    type: request.type,
    schoolName: request.schoolName,
    contactFirstName: request.contactFirstName,
    checkIn: request.checkIn.toISOString(),
    checkOut: request.checkOut.toISOString(),
    guestCount: parseBookingRequestGuests(request.guests).length,
    message: quote.message,
    expiresAt: quote.responseTokenExpiresAt!.toISOString(),
    options,
  };
}

type BookingRequestQuoteResponseAction =
  | "ACCEPT"
  | "CANCEL"
  | "MODIFY"
  | "QUERY";

export async function respondToBookingRequestQuote(input: {
  token: string;
  action: BookingRequestQuoteResponseAction;
  optionId?: string | null;
  message?: string | null;
}) {
  const quote = await loadSentQuoteByToken(input.token);
  const options = parseBookingRequestQuoteOptions(quote.options);
  const selectedOption = firstQuoteOption(options, input.optionId);
  if (input.action === "ACCEPT" && !selectedOption) {
    throw new BookingRequestQuoteError("Select one of the quoted options", 422);
  }

  const message = cleanNullableString(input.message);
  const respondedAt = new Date();

  if (input.action === "CANCEL") {
    await prisma.$transaction(async (tx) => {
      await tx.bookingRequestQuote.update({
        where: { id: quote.id },
        data: {
          status: BookingRequestQuoteStatus.CANCELLED,
          cancelledAt: respondedAt,
        },
      });
      await tx.bookingRequest.update({
        where: { id: quote.bookingRequestId },
        data: {
          status: BookingRequestStatus.CANCELLED,
          responseMessage: message,
          responseMessageAt: respondedAt,
        },
      });
      if (quote.bookingRequest.heldBookingId) {
        await tx.booking.update({
          where: { id: quote.bookingRequest.heldBookingId },
          data: { status: BookingStatus.CANCELLED },
        });
      }
    });
    logAudit({
      action: "booking_request.quote_cancelled",
      targetId: quote.bookingRequestId,
      entityType: "BookingRequest",
      entityId: quote.bookingRequestId,
      category: "booking",
      outcome: "success",
      summary: "Requester cancelled the booking request from the quote link",
      metadata: {
        actor: "requester",
        quoteId: quote.id,
        version: quote.version,
        releasedHeldBooking: Boolean(quote.bookingRequest.heldBookingId),
      },
    });
    return { outcome: "cancelled" as const };
  }

  if (input.action === "MODIFY" || input.action === "QUERY") {
    await prisma.$transaction(async (tx) => {
      await tx.bookingRequestQuote.update({
        where: { id: quote.id },
        data: {
          status: BookingRequestQuoteStatus.SUPERSEDED,
          supersededAt: respondedAt,
        },
      });
      await tx.bookingRequest.update({
        where: { id: quote.bookingRequestId },
        data: {
          status:
            input.action === "MODIFY"
              ? BookingRequestStatus.MODIFICATION_REQUESTED
              : BookingRequestStatus.QUERY_PENDING,
          responseMessage: message,
          responseMessageAt: respondedAt,
        },
      });
    });
    logAudit({
      action:
        input.action === "MODIFY"
          ? "booking_request.quote_modification_requested"
          : "booking_request.quote_query_raised",
      targetId: quote.bookingRequestId,
      entityType: "BookingRequest",
      entityId: quote.bookingRequestId,
      category: "booking",
      outcome: "success",
      summary:
        input.action === "MODIFY"
          ? "Requester asked for changes to the quote"
          : "Requester sent a question about the quote",
      metadata: {
        actor: "requester",
        quoteId: quote.id,
        version: quote.version,
        hasMessage: Boolean(message),
      },
    });
    return {
      outcome:
        input.action === "MODIFY"
          ? ("modification_requested" as const)
          : ("query_sent" as const),
    };
  }

  const option = selectedOption!;
  const createdByMemberId = quote.createdByMemberId;
  if (!createdByMemberId) {
    throw new BookingRequestQuoteError(
      "This quote is missing its admin owner and cannot be accepted.",
      409
    );
  }

  // Re-arming a just-converted request back to PRICED here is safe: approve is
  // idempotent on convertedBookingId (#1232), so a concurrent double-accept
  // returns the existing booking instead of creating a second one.
  await prisma.bookingRequest.update({
    where: { id: quote.bookingRequestId },
    data: {
      status: BookingRequestStatus.PRICED,
      priceCents: option.totalCents,
      acceptedQuoteId: quote.id,
      acceptedQuoteOptionId: option.id,
      acceptedQuoteSnapshot: option as unknown as Prisma.InputJsonValue,
      acceptedPriceCents: option.totalCents,
      acceptedAt: respondedAt,
      responseMessage: message,
      responseMessageAt: message ? respondedAt : null,
    },
  });

  const conversion =
    quote.bookingRequest.type === BookingRequestType.SCHOOL
      ? await approveSchoolBookingRequest({
          requestId: quote.bookingRequestId,
          adminMemberId: createdByMemberId,
        })
      : await approveBookingRequest({
          requestId: quote.bookingRequestId,
          adminMemberId: createdByMemberId,
        });

  if (conversion.type === "capacityExceeded") {
    await prisma.bookingRequest.update({
      where: { id: quote.bookingRequestId },
      data: {
        status: BookingRequestStatus.QUOTE_SENT,
        acceptedQuoteId: null,
        acceptedQuoteOptionId: null,
        acceptedQuoteSnapshot: Prisma.JsonNull,
        acceptedPriceCents: null,
        acceptedAt: null,
      },
    });
    logAudit({
      action: "booking_request.quote_accept_capacity_blocked",
      targetId: quote.bookingRequestId,
      entityType: "BookingRequest",
      entityId: quote.bookingRequestId,
      category: "booking",
      outcome: "blocked",
      summary:
        "Quote acceptance reverted because the lodge filled before confirmation",
      metadata: {
        actor: "requester",
        quoteId: quote.id,
        optionId: option.id,
        fullNights: conversion.fullNights,
      },
    });
    const nights = conversion.fullNights.join(", ");
    throw new BookingRequestQuoteError(
      nights
        ? `The lodge filled up before your acceptance could be confirmed. These nights are now full: ${nights}. Your quote link is still active — reply to the booking team to discuss alternative dates.`
        : "The lodge filled up before your acceptance could be confirmed. Your quote link is still active — reply to the booking team to discuss alternative dates.",
      409
    );
  }

  await prisma.bookingRequestQuote.update({
    where: { id: quote.id },
    data: {
      status: BookingRequestQuoteStatus.ACCEPTED,
      acceptedAt: respondedAt,
    },
  });

  logAudit({
    action: "booking_request.quote_accepted",
    targetId: quote.bookingRequestId,
    entityType: "BookingRequest",
    entityId: quote.bookingRequestId,
    category: "booking",
    outcome: "success",
    summary: "Requester accepted the quote",
    metadata: {
      actor: "requester",
      quoteId: quote.id,
      version: quote.version,
      optionId: option.id,
      priceCents: option.totalCents,
      bookingId: conversion.bookingId,
    },
  });

  return {
    outcome: "accepted" as const,
    bookingId: conversion.bookingId,
    priceCents: option.totalCents,
    type: quote.bookingRequest.type,
  };
}

function getCapacityFullNights(
  nightDetails: Array<{ date: Date; availableBeds: number }>
): string[] {
  return nightDetails
    .filter((night) => night.availableBeds < 0)
    .map((night) => night.date.toISOString().split("T")[0]);
}

export async function holdBookingRequestSlots(input: {
  requestId: string;
  adminMemberId: string;
  optionId?: string | null;
}) {
  const request = await prisma.bookingRequest.findUnique({
    where: { id: input.requestId },
    include: {
      quotes: {
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });
  if (!request) {
    throw new BookingRequestError("Booking request not found", 404);
  }
  if (!holdableStatuses.includes(request.status as never)) {
    throw new BookingRequestError("This booking request cannot be held", 409);
  }
  if (request.heldBookingId) {
    return { type: "held" as const, bookingId: request.heldBookingId, reused: true };
  }

  const guests = parseBookingRequestGuests(request.guests);
  const latestQuote = request.quotes[0] ?? null;
  const quoteOptions = latestQuote
    ? parseBookingRequestQuoteOptions(latestQuote.options)
    : [];
  const option =
    firstQuoteOption(quoteOptions, input.optionId) ??
    (request.priceCents != null
      ? {
          id: "LEGACY_PRICE",
          label: "Quoted price",
          cateringOption: null,
          totalCents: request.priceCents,
          pricingMode: BookingRequestPricingMode.OVERALL_TOTAL,
          guestBreakdown: [],
        }
      : null);

  if (!option) {
    throw new BookingRequestQuoteError("Create a quote before holding capacity", 409);
  }

  const placeholderPasswordHash = await hash(randomBytes(32).toString("hex"), 13);
  const linkedMembers = linkedGuestMemberMap(request.linkedGuestMembers);
  const guestPriceCents = splitPriceAcrossGuests(option.totalCents, guests.length);
  const guestCreates = guests.map((guest, index) => {
    const memberId = linkedMembers.get(index);
    return {
      firstName: guest.firstName,
      lastName: guest.lastName,
      ageTier: guest.ageTier,
      isMember: Boolean(memberId),
      memberId,
      stayStart: request.checkIn,
      stayEnd: request.checkOut,
      priceCents: guestPriceCents[index] ?? 0,
    };
  });

  let capacityFullNights: string[] | null = null;

  try {
    const booking = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(1)`;

      const claimed = await tx.bookingRequest.updateMany({
        where: {
          id: request.id,
          heldBookingId: null,
          status: { in: [...holdableStatuses] },
        },
        data: { updatedAt: new Date() },
      });
      if (claimed.count === 0) {
        const current = await tx.bookingRequest.findUnique({
          where: { id: request.id },
          select: { heldBookingId: true },
        });
        if (current?.heldBookingId) {
          return { id: current.heldBookingId, reused: true };
        }
        throw new BookingRequestError("This booking request cannot be held", 409);
      }

      const capacityRanges = guests.map(() => ({
        stayStart: request.checkIn,
        stayEnd: request.checkOut,
      }));
      const capacity = await checkCapacityForGuestRanges(
        request.checkIn,
        request.checkOut,
        capacityRanges,
        undefined,
        tx
      );
      if (!capacity.available) {
        capacityFullNights = getCapacityFullNights(capacity.nightDetails);
        throw new Error("CAPACITY_EXCEEDED_SENTINEL");
      }

      // Block admin-mediated double-books: a request whose guests an admin
      // linked to real members must not put a member on overlapping nights
      // (issue #1158, invariant DOMAIN_INVARIANTS.md:35-40). A brand-new held
      // booking is being created, so there is nothing to exclude.
      await assertNoBookingMemberNightConflicts(tx, {
        actorMemberId: input.adminMemberId,
        actorRole: "ADMIN",
        checkIn: request.checkIn,
        checkOut: request.checkOut,
        guests: guestCreates,
      });

      const ownerName =
        request.type === BookingRequestType.SCHOOL
          ? request.schoolName ?? `${request.contactFirstName} ${request.contactLastName}`
          : request.contactFirstName;
      const ownerLastName =
        request.type === BookingRequestType.SCHOOL ? "" : request.contactLastName;
      // Held booking owners are non-login records, never paying members: school
      // requests become SCHOOL, all other request types become NON_MEMBER.
      const ownerRole =
        request.type === BookingRequestType.SCHOOL ? "SCHOOL" : "NON_MEMBER";

      const member = await tx.member.create({
        data: {
          email: request.contactEmail,
          passwordHash: placeholderPasswordHash,
          emailVerified: true,
          firstName: ownerName.slice(0, 100),
          lastName: ownerLastName.slice(0, 100),
          role: ownerRole,
          ageTier: AgeTier.ADULT,
          active: true,
          canLogin: false,
          phoneNumber: request.contactPhone,
        },
        select: { id: true },
      });

      const held = await tx.booking.create({
        data: {
          memberId: member.id,
          checkIn: request.checkIn,
          checkOut: request.checkOut,
          status: BookingStatus.AWAITING_REVIEW,
          totalPriceCents: option.totalCents,
          finalPriceCents: option.totalCents,
          hasNonMembers: true,
          notes: request.message,
          createdById: input.adminMemberId,
          guests: { create: guestCreates },
        },
        select: { id: true },
      });

      await tx.bookingRequest.update({
        where: { id: request.id },
        data: { heldBookingId: held.id },
      });

      return { id: held.id, reused: false };
    });

    logAudit({
      action: "booking_request.capacity_held",
      memberId: input.adminMemberId,
      actorMemberId: input.adminMemberId,
      targetId: request.id,
      entityType: "BookingRequest",
      entityId: request.id,
      category: "booking",
      outcome: "success",
      summary: "Booking request capacity held",
      metadata: {
        bookingId: booking.id,
        reused: booking.reused,
        optionId: option.id,
        priceCents: option.totalCents,
      },
    });

    return { type: "held" as const, bookingId: booking.id, reused: booking.reused };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "CAPACITY_EXCEEDED_SENTINEL" &&
      capacityFullNights
    ) {
      return { type: "capacityExceeded" as const, fullNights: capacityFullNights };
    }
    throw err;
  }
}
