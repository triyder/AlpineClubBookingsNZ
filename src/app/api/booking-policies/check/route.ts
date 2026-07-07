import { NextRequest, NextResponse } from "next/server"
import { requireActiveSession } from "@/lib/session-guards"
import { validateMinimumStay, formatViolationsDetail } from "@/lib/booking-policies"
import { z } from "zod"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

const bookingPolicyCheckQuerySchema = z.object({
  checkIn: dateOnlyString.transform(parseDateOnly),
  checkOut: dateOnlyString.transform(parseDateOnly),
  // Lodge being booked (multi-lodge phase 8): minimum-stay overrides resolve
  // per lodge. Omitted = the club's default lodge.
  lodgeId: z.string().min(1).nullish(),
})

export async function GET(request: NextRequest) {
  const guard = await requireActiveSession()
  if (!guard.ok) return guard.response

  const parsed = bookingPolicyCheckQuerySchema.safeParse({
    checkIn: request.nextUrl.searchParams.get("checkIn"),
    checkOut: request.nextUrl.searchParams.get("checkOut"),
    lodgeId: request.nextUrl.searchParams.get("lodgeId"),
  })

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { checkIn, checkOut } = parsed.data

  if (checkOut <= checkIn) {
    return NextResponse.json(
      { error: "checkOut must be after checkIn" },
      { status: 400 }
    )
  }

  const result = await validateMinimumStay(checkIn, checkOut, parsed.data.lodgeId)

  return NextResponse.json({
    valid: result.valid,
    violations: result.violations,
    message: result.valid ? null : formatViolationsDetail(result.violations),
  })
}
