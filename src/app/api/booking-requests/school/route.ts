import { NextRequest, NextResponse } from "next/server";
import { SchoolCateringPreference } from "@prisma/client";
import { z } from "zod";
import { BookingRequestError } from "@/lib/booking-request";
import {
  createSchoolBookingRequest,
  generateSchoolGuests,
  schoolChildCountsSchema,
  schoolTeacherSchema,
} from "@/lib/school-booking-request";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { getTodayDateOnly, isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { nameField } from "@/lib/zod-helpers";
import logger from "@/lib/logger";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

const noCrlf = (value: string) => !/[\r\n]/.test(value);

const schoolBookingRequestSchema = z.object({
  schoolName: z
    .string()
    .min(1, "School name is required")
    .max(200)
    .refine(noCrlf, "School name cannot contain line breaks"),
  contactFirstName: nameField(),
  contactLastName: nameField(),
  contactEmail: z.string().email("Invalid email address").max(200),
  contactPhone: z
    .string()
    .max(30)
    .refine(noCrlf, "Phone number cannot contain line breaks")
    .optional()
    .nullable(),
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  cateringPreference: z
    .enum(["CATERED", "NON_CATERED", "QUOTE_BOTH"])
    .default("QUOTE_BOTH"),
  teachers: z.array(schoolTeacherSchema).min(1, "At least one teacher is required").max(50),
  childCounts: schoolChildCountsSchema,
  message: z
    .string()
    .max(1000)
    .refine(noCrlf, "Message cannot contain line breaks")
    .optional()
    .nullable(),
});

export async function POST(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingRequest, request);
  if (rateLimited) return rateLimited;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = schoolBookingRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten().fieldErrors },
      { status: 422 }
    );
  }

  const { checkIn, checkOut, teachers, childCounts } = parsed.data;

  if (checkOut <= checkIn) {
    return NextResponse.json({ error: "Check-out must be after check-in" }, { status: 400 });
  }

  const today = getTodayDateOnly();
  if (checkIn < today) {
    return NextResponse.json({ error: "Cannot request a booking in the past" }, { status: 400 });
  }

  const guests = generateSchoolGuests({ teachers, childCounts });
  if (guests.length === 0) {
    return NextResponse.json(
      { error: "Add at least one teacher and one child" },
      { status: 400 }
    );
  }

  const lodgeCapacity = await getLodgeCapacity();
  if (guests.length > lodgeCapacity) {
    return NextResponse.json(
      { error: `A school booking cannot exceed the lodge capacity of ${lodgeCapacity} guests` },
      { status: 400 }
    );
  }

  try {
    await createSchoolBookingRequest({
      schoolName: parsed.data.schoolName,
      contactFirstName: parsed.data.contactFirstName,
      contactLastName: parsed.data.contactLastName,
      contactEmail: parsed.data.contactEmail,
      contactPhone: parsed.data.contactPhone,
      checkIn,
      checkOut,
      cateringPreference: parsed.data.cateringPreference as SchoolCateringPreference,
      teachers,
      childCounts,
      message: parsed.data.message,
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    if (err instanceof BookingRequestError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }

    logger.error({ err }, "Unexpected error creating school booking request");
    return NextResponse.json(
      { error: "Unable to submit school booking request right now" },
      { status: 500 }
    );
  }
}
