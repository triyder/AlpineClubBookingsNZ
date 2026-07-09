import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { BookingRequestStatus } from "@prisma/client";
import {
  buildBookingRequestListWhere,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { parseBookingRequestQuoteOptions } from "@/lib/booking-request-quotes";
import { loadSchoolGroupSoftCap } from "@/lib/lodge-settings";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const statusFilterValues = [
  ...Object.values(BookingRequestStatus),
  "QUEUE",
  "ALL",
] as const;

const querySchema = z.object({
  status: z.enum(statusFilterValues).optional().default("QUEUE"),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(25),
});

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { status, page, pageSize } = parsed.data;
  const where = buildBookingRequestListWhere(status);

  const [requests, total] = await Promise.all([
    prisma.bookingRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: pageSize,
      skip: (page - 1) * pageSize,
      // Lodge name for the queue display; null lodgeId means the club's
      // default lodge (pre-multi-lodge rows and single-lodge submissions).
      include: { lodge: { select: { name: true } } },
    }),
    prisma.bookingRequest.count({ where }),
  ]);

  const reviewerIds = Array.from(
    new Set(
      requests.flatMap((request) => [
        request.pricedByMemberId,
        request.reviewedByMemberId,
        request.convertedMemberId,
      ])
    )
  ).filter((id): id is string => Boolean(id));

  const reviewers = reviewerIds.length
    ? await prisma.member.findMany({
        where: { id: { in: reviewerIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const reviewerNames = new Map(
    reviewers.map((member) => [member.id, `${member.firstName} ${member.lastName}`])
  );
  const latestQuotes = requests.length
    ? await prisma.bookingRequestQuote.findMany({
        where: { bookingRequestId: { in: requests.map((request) => request.id) } },
        distinct: ["bookingRequestId"],
        orderBy: [{ bookingRequestId: "asc" }, { version: "desc" }],
      })
    : [];
  const latestQuoteByRequestId = new Map(
    latestQuotes.map((quote) => [quote.bookingRequestId, quote])
  );

  // Resolve the school-group soft cap per request lodge through the same
  // settings path enforcement uses (loadSchoolGroupSoftCap), so the queue's
  // "Over N" hint can't diverge from the actual per-lodge threshold. A null
  // lodgeId means the club's default lodge, which resolves to the legacy row —
  // byte-identical to the previous DEFAULT_SCHOOL_GROUP_SOFT_CAP for a
  // single-lodge club with no override. Resolved once per distinct lodge (not
  // per request) to keep the query count flat as the queue grows.
  const distinctLodgeIds = Array.from(
    new Set(requests.map((request) => request.lodgeId))
  );
  const softCapByLodgeId = new Map(
    await Promise.all(
      distinctLodgeIds.map(
        async (lodgeId) =>
          [lodgeId, await loadSchoolGroupSoftCap(prisma, lodgeId)] as const
      )
    )
  );

  const data = requests.map((request) => ({
    ...serializeBookingRequestForAdmin(request),
    schoolGroupSoftCap: softCapByLodgeId.get(request.lodgeId)!,
    pricedByMemberName: request.pricedByMemberId
      ? reviewerNames.get(request.pricedByMemberId) ?? null
      : null,
    reviewedByMemberName: request.reviewedByMemberId
      ? reviewerNames.get(request.reviewedByMemberId) ?? null
      : null,
    latestQuote: latestQuoteByRequestId.has(request.id)
      ? {
          id: latestQuoteByRequestId.get(request.id)!.id,
          version: latestQuoteByRequestId.get(request.id)!.version,
          status: latestQuoteByRequestId.get(request.id)!.status,
          pricingMode: latestQuoteByRequestId.get(request.id)!.pricingMode,
          sentAt: latestQuoteByRequestId.get(request.id)!.sentAt?.toISOString() ?? null,
          responseTokenExpiresAt:
            latestQuoteByRequestId.get(request.id)!.responseTokenExpiresAt?.toISOString() ??
            null,
          options: parseBookingRequestQuoteOptions(
            latestQuoteByRequestId.get(request.id)!.options
          ),
        }
      : null,
  }));

  return NextResponse.json({ data, page, pageSize, total });
}
