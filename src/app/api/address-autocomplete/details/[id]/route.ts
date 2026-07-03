import { NextResponse } from "next/server";
import {
  addyAddressIdSchema,
  getAddyAddressSelection,
} from "@/lib/addy-api";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import { z } from "zod";

const detailsQuerySchema = z.object({
  session: z
    .string()
    .trim()
    .max(80)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rateLimited = await applyRateLimit(
    rateLimiters.addressAutocomplete,
    request,
  );
  if (rateLimited) return rateLimited;

  const { id } = await context.params;
  const parsedId = addyAddressIdSchema.safeParse(id);

  if (!parsedId.success) {
    return NextResponse.json({ error: "Invalid address id" }, { status: 400 });
  }

  const searchParams = Object.fromEntries(new URL(request.url).searchParams);
  const parsedQuery = detailsQuerySchema.safeParse(searchParams);

  if (!parsedQuery.success) {
    return NextResponse.json({ error: "Invalid address query" }, { status: 400 });
  }

  try {
    const result = await getAddyAddressSelection({
      id: parsedId.data,
      session: parsedQuery.data.session,
    });

    if (!result.configured) {
      return NextResponse.json(
        { error: "Address autocomplete is not configured" },
        { status: 503 },
      );
    }

    return NextResponse.json({ selection: result.selection });
  } catch {
    return NextResponse.json(
      { error: "Address details are unavailable" },
      { status: 502 },
    );
  }
}
