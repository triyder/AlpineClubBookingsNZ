import { NextResponse } from "next/server";

export async function parseJsonRequestBody(request: Request): Promise<
  | { ok: true; body: unknown }
  | { ok: false; response: NextResponse }
> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: "Invalid JSON",
          details: { body: ["Request body must be valid JSON"] },
        },
        { status: 400 },
      ),
    };
  }
}
