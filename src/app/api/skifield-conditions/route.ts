import { NextResponse } from "next/server";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

const SNZ_WIDGET_ENDPOINT_PREFIX = "https://snowhq.com/widget/";
const PUBLIC_CACHE_CONTROL = "public, max-age=600, stale-while-revalidate=1800";

const EMPTY_WIDGET_PAYLOAD = {
  Type: "Small",
  Areas: [],
  AreaStatus: false,
  RoadStatus: false,
  CurrentWeatherConditions: false,
};

function isValidHash(value: string) {
  return /^[a-f0-9]{32}$/i.test(value);
}

export async function GET(request: Request) {
  const rateLimited = await applyRateLimit(rateLimiters.skifieldConditions, request);
  if (rateLimited) return rateLimited;

  const { searchParams } = new URL(request.url);
  const hash = (searchParams.get("hash") ?? "").trim();

  if (!isValidHash(hash)) {
    return NextResponse.json(
      {
        ...EMPTY_WIDGET_PAYLOAD,
        _error: "A valid 32-character widget hash is required.",
      },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  const upstream = await fetch(`${SNZ_WIDGET_ENDPOINT_PREFIX}${hash}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json,text/plain,*/*",
      "User-Agent": "AlpineClubBookingsNZ/1.0 (+widget-proxy)",
    },
    cache: "no-store",
  });

  const body = await upstream.text();

  if (!upstream.ok || body.trim().length === 0) {
    return NextResponse.json(
      {
        ...EMPTY_WIDGET_PAYLOAD,
        _error:
          "Snow widget data was empty or unavailable from the upstream service.",
        upstreamStatus: upstream.status,
      },
      {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": PUBLIC_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
