import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import {
  coerceWhakapapaCurlData,
  coerceWhakapapaSectionVisibility,
  emptyWhakapapaCurlData,
  type WhakapapaSectionVisibility,
} from "@/lib/whakapapa-report";
import { fetchWhakapapaCurlData } from "@/lib/whakapapa-report.server";

const WHAKAPAPA_SOURCE = "whakapapa-report";
const ADMIN_FREEZE_TTL_MS = 12 * 60 * 60 * 1000;

type WhakapapaReportCacheRecord = {
  source: string;
  payload: Prisma.JsonValue;
  fetchedAt: Date;
  frozenUntil: Date | null;
  updatedAt: Date;
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

function toResponseRecord(record: {
  source: string;
  payload: Prisma.JsonValue;
  fetchedAt: Date;
  frozenUntil: Date | null;
  updatedAt: Date;
}) {
  const payload =
    coerceWhakapapaCurlData(record.payload) ?? emptyWhakapapaCurlData();

  return {
    source: record.source,
    payload,
    fetchedAt: record.fetchedAt.toISOString(),
    frozenUntil: record.frozenUntil?.toISOString() ?? null,
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function getCurrentRecord() {
  const record = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  return record ? toResponseRecord(record) : null;
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "view" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  return NextResponse.json({
    record: await getCurrentRecord(),
  });
}

export async function PUT(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawJson =
    body && typeof body === "object" && "rawJson" in body
      ? String((body as { rawJson?: unknown }).rawJson ?? "")
      : "";

  if (!rawJson.trim()) {
    return NextResponse.json({ error: "rawJson is required" }, { status: 400 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON content" },
      { status: 400 },
    );
  }

  const payload = coerceWhakapapaCurlData(parsed);
  if (!payload) {
    return NextResponse.json(
      { error: "JSON does not match the Whakapapa conditions shape" },
      { status: 400 },
    );
  }

  const now = new Date();
  const frozenUntil = new Date(now.getTime() + ADMIN_FREEZE_TTL_MS);

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil,
    },
  });

  return NextResponse.json({
    record: toResponseRecord(record),
    message: "Mountain conditions saved. Auto refresh is paused for 12 hours.",
  });
}

export async function POST() {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const existing = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  const payload = await fetchWhakapapaCurlData();

  // Section visibility is admin-controlled config stored in the payload; keep
  // the current choices instead of resetting them on an upstream refresh.
  const existingData = coerceWhakapapaCurlData(existing?.payload);
  if (existingData) {
    payload.visibility = existingData.visibility;
  }

  const now = new Date();

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil: null,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt: now,
      frozenUntil: null,
    },
  });

  return NextResponse.json({
    record: toResponseRecord(record),
    message: "Mountain conditions refreshed from Whakapapa.",
  });
}

export async function PATCH(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "content", level: "edit" },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawVisibility =
    body && typeof body === "object" && "visibility" in body
      ? (body as { visibility?: unknown }).visibility
      : undefined;

  if (!rawVisibility || typeof rawVisibility !== "object") {
    return NextResponse.json(
      { error: "visibility object is required" },
      { status: 400 },
    );
  }

  const visibility: WhakapapaSectionVisibility =
    coerceWhakapapaSectionVisibility(rawVisibility);

  // Read-modify-write: a concurrent POST/PUT/public-GET refresh between this
  // read and the upsert below can clobber a just-fetched report with the older
  // report data carried on this toggle (last write wins). Accepted at club
  // scale — admin toggles are rare and self-heal on the next upstream refresh.
  const existing = await whakapapaReportCache.findUnique({
    where: { source: WHAKAPAPA_SOURCE },
  });

  // Toggling visibility only changes display config, so preserve the cached
  // report data, its fetch timestamp, and any active freeze window.
  const payload =
    coerceWhakapapaCurlData(existing?.payload) ?? emptyWhakapapaCurlData();
  payload.visibility = visibility;

  // On the create path (no cache row yet) the report data is empty, so backdate
  // fetchedAt to the epoch to mark the row stale. Otherwise the public GET would
  // treat this visibility-only row as "fresh" for the TTL window and serve empty
  // sections instead of triggering an upstream fetch. An existing row keeps its
  // real fetch timestamp so a genuine cached report stays fresh.
  const fetchedAt = existing?.fetchedAt ?? new Date(0);
  const frozenUntil = existing?.frozenUntil ?? null;

  const record = await whakapapaReportCache.upsert({
    where: { source: WHAKAPAPA_SOURCE },
    create: {
      source: WHAKAPAPA_SOURCE,
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt,
      frozenUntil,
    },
    update: {
      payload: payload as unknown as Prisma.InputJsonValue,
      fetchedAt,
      frozenUntil,
    },
  });

  return NextResponse.json({
    record: toResponseRecord(record),
    message: "Section visibility saved.",
  });
}
