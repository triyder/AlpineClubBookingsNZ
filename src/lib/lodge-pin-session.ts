import bcrypt from "bcryptjs";
import { createHmac, randomInt, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { addDaysDateOnly, formatDateOnly, getTodayDateOnly } from "./date-only";
import { getAuthSecret } from "./runtime-config";

export const HUT_LEADER_PIN_SESSION_COOKIE = "tac_hut_leader_pin_session";

const HUT_LEADER_PIN_BCRYPT_ROUNDS = 12;
const HUT_LEADER_PIN_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const PIN_LOCKOUT_THRESHOLD = 10;
const PIN_LOCKOUT_SECONDS = 15 * 60;
const PIN_FAILURE_RESET_MS = 15 * 60 * 1000;

interface PinSessionPayload {
  assignmentId: string;
  memberId: string;
  exp: number;
  pinVersion?: string;
  sessionUserBinding?: string;
}

interface PinFailureEntry {
  count: number;
  lastFailedAt: number;
  lockedUntil: number | null;
}

const failureStore = new Map<string, PinFailureEntry>();

function getPinSessionSecret(): string {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("AUTH_SECRET or NEXTAUTH_SECRET is required for lodge PIN sessions");
  }
  return secret;
}

function signPayload(payloadPart: string): string {
  return createHmac("sha256", getPinSessionSecret())
    .update(payloadPart)
    .digest("base64url");
}

function encodePayload(payload: PinSessionPayload): string {
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadPart}.${signPayload(payloadPart)}`;
}

function derivePinSessionVersion(pinHash: string) {
  return createHmac("sha256", getPinSessionSecret())
    .update(pinHash)
    .digest("base64url");
}

function deriveSessionUserBinding(sessionUserId: string) {
  return createHmac("sha256", getPinSessionSecret())
    .update(`lodge-pin-session:${sessionUserId}`)
    .digest("base64url");
}

function isTimingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");

  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function decodePayload(rawValue: string): PinSessionPayload | null {
  const [payloadPart, signaturePart] = rawValue.split(".");
  if (!payloadPart || !signaturePart) {
    return null;
  }

  const expectedSignature = signPayload(payloadPart);
  const signatureBuffer = Buffer.from(signaturePart, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8")
    ) as Partial<PinSessionPayload>;

    if (
      typeof payload.assignmentId !== "string" ||
      typeof payload.memberId !== "string" ||
      typeof payload.exp !== "number" ||
      (payload.pinVersion !== undefined && typeof payload.pinVersion !== "string") ||
      (payload.sessionUserBinding !== undefined &&
        typeof payload.sessionUserBinding !== "string")
    ) {
      return null;
    }

    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      assignmentId: payload.assignmentId,
      memberId: payload.memberId,
      exp: payload.exp,
      pinVersion: payload.pinVersion,
      sessionUserBinding: payload.sessionUserBinding,
    };
  } catch {
    return null;
  }
}

function getCookieValueFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name === HUT_LEADER_PIN_SESSION_COOKIE) {
      return valueParts.join("=") || null;
    }
  }

  return null;
}

function getAssignmentRange(assignment: {
  startDate: Date;
  endDate: Date;
}) {
  return {
    minDate: formatDateOnly(addDaysDateOnly(assignment.startDate, -1)),
    maxDate: formatDateOnly(assignment.endDate),
  };
}

export function generateHutLeaderPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function hashHutLeaderPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, HUT_LEADER_PIN_BCRYPT_ROUNDS);
}

export async function findActiveHutLeaderAssignmentByPin(
  pin: string,
  date = getTodayDateOnly(),
  kioskLodgeId?: string
) {
  const nextDay = addDaysDateOnly(date, 1);
  const assignments = await prisma.hutLeaderAssignment.findMany({
    where: {
      hutLeaderPin: { not: null },
      startDate: { lte: nextDay },
      endDate: { gte: date },
      // A hut leader serves one lodge (ADR-001 resolved question 5): a PIN
      // only works on that lodge's kiosk. lodgeId is NOT NULL, so scope the
      // PIN lookup strictly to the kiosk's lodge when one is supplied.
      ...(kioskLodgeId ? { lodgeId: kioskLodgeId } : {}),
    },
    include: {
      member: {
        select: {
          id: true,
          active: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  for (const assignment of assignments) {
    if (!assignment.hutLeaderPin || !assignment.member.active) {
      continue;
    }

    if (await bcrypt.compare(pin, assignment.hutLeaderPin)) {
      return assignment;
    }
  }

  return null;
}

export function createLodgePinSessionWithVersion(
  assignmentId: string,
  memberId: string,
  pinHash?: string | null,
  sessionUserId?: string | null
) {
  const expiresAt = new Date(
    Date.now() + HUT_LEADER_PIN_SESSION_MAX_AGE_SECONDS * 1000
  );

  return {
    value: encodePayload({
      assignmentId,
      memberId,
      exp: Math.floor(expiresAt.getTime() / 1000),
      pinVersion: pinHash ? derivePinSessionVersion(pinHash) : undefined,
      sessionUserBinding: sessionUserId
        ? deriveSessionUserBinding(sessionUserId)
        : undefined,
    }),
    expiresAt,
    maxAge: HUT_LEADER_PIN_SESSION_MAX_AGE_SECONDS,
  };
}

// test seam
export async function getActiveLodgePinSessionForDate(
  date: Date,
  rawCookieValue: string | null,
  sessionUserId?: string | null
) {
  if (!rawCookieValue) {
    return null;
  }

  const payload = decodePayload(rawCookieValue);
  if (!payload) {
    return null;
  }

  if (sessionUserId) {
    const expectedBinding = deriveSessionUserBinding(sessionUserId);
    if (
      !payload.sessionUserBinding ||
      !isTimingSafeStringEqual(payload.sessionUserBinding, expectedBinding)
    ) {
      return null;
    }
  }

  const assignment = await prisma.hutLeaderAssignment.findUnique({
    where: { id: payload.assignmentId },
    include: {
      member: {
        select: {
          id: true,
          active: true,
          firstName: true,
          lastName: true,
          email: true,
        },
      },
    },
  });

  if (
    !assignment ||
    assignment.memberId !== payload.memberId ||
    !assignment.member.active ||
    !assignment.hutLeaderPin
  ) {
    return null;
  }

  if (
    !payload.pinVersion ||
    payload.pinVersion !== derivePinSessionVersion(assignment.hutLeaderPin)
  ) {
    return null;
  }

  const rangeStart = addDaysDateOnly(assignment.startDate, -1);
  if (date < rangeStart || date > assignment.endDate) {
    return null;
  }

  return {
    assignmentId: assignment.id,
    memberId: assignment.memberId,
    member: assignment.member,
    dateRange: getAssignmentRange(assignment),
  };
}

export async function getActiveLodgePinSessionForRequest(
  request: Request,
  date: Date,
  sessionUserId: string
) {
  return getActiveLodgePinSessionForDate(
    date,
    getCookieValueFromRequest(request),
    sessionUserId
  );
}

export async function hasAnyActiveLodgePinSession(
  sessionUserId?: string | null
): Promise<boolean> {
  const cookieStore = await cookies();
  const rawCookieValue = cookieStore.get(HUT_LEADER_PIN_SESSION_COOKIE)?.value ?? null;
  const session = await getActiveLodgePinSessionForDate(
    getTodayDateOnly(),
    rawCookieValue,
    sessionUserId
  );
  return Boolean(session);
}

function getFailureEntry(ip: string): PinFailureEntry | null {
  const entry = failureStore.get(ip);
  if (!entry) {
    return null;
  }

  const now = Date.now();

  if (entry.lockedUntil && entry.lockedUntil <= now) {
    failureStore.delete(ip);
    return null;
  }

  if (!entry.lockedUntil && now - entry.lastFailedAt > PIN_FAILURE_RESET_MS) {
    failureStore.delete(ip);
    return null;
  }

  return entry;
}

export function getLodgePinLockout(ip: string) {
  const entry = getFailureEntry(ip);
  const now = Date.now();

  if (!entry || !entry.lockedUntil || entry.lockedUntil <= now) {
    return { locked: false, retryAfter: 0 };
  }

  return {
    locked: true,
    retryAfter: Math.ceil((entry.lockedUntil - now) / 1000),
  };
}

export function recordLodgePinFailure(ip: string) {
  const now = Date.now();
  const existing = getFailureEntry(ip);
  const nextCount = (existing?.count ?? 0) + 1;

  const lockedUntil =
    nextCount >= PIN_LOCKOUT_THRESHOLD
      ? now + PIN_LOCKOUT_SECONDS * 1000
      : null;

  failureStore.set(ip, {
    count: nextCount,
    lastFailedAt: now,
    lockedUntil,
  });

  return {
    count: nextCount,
    locked: Boolean(lockedUntil),
    retryAfter: lockedUntil
      ? Math.ceil((lockedUntil - now) / 1000)
      : 0,
  };
}

export function clearLodgePinFailures(ip: string) {
  failureStore.delete(ip);
}

// test seam
export { failureStore as _testLodgePinFailureStore };
