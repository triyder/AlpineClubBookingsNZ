import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  coerceWhakapapaCurlData,
  emptyWhakapapaCurlData,
} from "@/lib/whakapapa-report";
import { fetchWhakapapaCurlData } from "@/lib/whakapapa-report.server";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";
import logger from "@/lib/logger";

export const runtime = "nodejs";

const WHAKAPAPA_SOURCE = "whakapapa-report";
const CACHE_TTL_MS = 60 * 60 * 1000;
const PUBLIC_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=1800";

type WhakapapaReportCacheRecord = {
  source: string;
  payload: Prisma.JsonValue;
  fetchedAt: Date;
  frozenUntil: Date | null;
};

type WhakapapaReportCacheDelegate = {
  findUnique(args: {
    where: { source: string };
  }): Promise<WhakapapaReportCacheRecord | null>;
  upsert(args: {
    where: { source: string };
    create: {
      source: string;
      payload: Prisma.InputJsonValue;
      fetchedAt: Date;
      frozenUntil: Date | null;
    };
    update: {
      payload: Prisma.InputJsonValue;
      fetchedAt: Date;
      frozenUntil: Date | null;
    };
  }): Promise<WhakapapaReportCacheRecord>;
};

const whakapapaReportCache = (
  prisma as unknown as { whakapapaReportCache: WhakapapaReportCacheDelegate }
).whakapapaReportCache;

function isFresh(fetchedAt: Date): boolean {
  return Date.now() - fetchedAt.getTime() < CACHE_TTL_MS;
}

function isFrozenUntil(frozenUntil: Date | null): boolean {
  return frozenUntil != null && frozenUntil.getTime() > Date.now();
}

export async function GET(request: Request) {
  const rateLimited = await applyRateLimit(
    rateLimiters.skifieldConditions,
    request,
  );
  if (rateLimited) return rateLimited;

  const existing = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  const cachedData = coerceWhakapapaCurlData(existing?.payload);
  if (
    existing &&
    cachedData &&
    (isFrozenUntil(existing.frozenUntil) || isFresh(existing.fetchedAt))
  ) {
    return NextResponse.json(cachedData, {
      status: 200,
      headers: {
        "Cache-Control": PUBLIC_CACHE_CONTROL,
      },
    });
  }

  try {
    const curlData = await fetchWhakapapaCurlData();

    // Section visibility is admin-controlled config that lives in the cached
    // payload, so carry it across upstream refreshes instead of resetting it.
    if (cachedData) {
      curlData.visibility = cachedData.visibility;
    }

    await whakapapaReportCache.upsert({
      where: { source: WHAKAPAPA_SOURCE },
      create: {
        source: WHAKAPAPA_SOURCE,
        payload: curlData as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
        frozenUntil: null,
      },
      update: {
        payload: curlData as unknown as Prisma.InputJsonValue,
        fetchedAt: new Date(),
        frozenUntil: null,
      },
    });

    return NextResponse.json(curlData, {
      status: 200,
      headers: {
        "Cache-Control": PUBLIC_CACHE_CONTROL,
      },
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to refresh Whakapapa report data");
    if (cachedData) {
      return NextResponse.json(
        {
          ...cachedData,
          error: "Unable to refresh Whakapapa report data.",
          stale: true,
        },
        {
          status: 200,
          headers: {
            "Cache-Control": PUBLIC_CACHE_CONTROL,
          },
        },
      );
    }

    const empty = emptyWhakapapaCurlData();
    empty.updated = new Date().toISOString();

    return NextResponse.json(
      {
        ...empty,
        error: "Unable to fetch Whakapapa report data.",
      },
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
