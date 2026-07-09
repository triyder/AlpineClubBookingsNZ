import { clubConfig } from "@/config/club";
import { escapeHtml } from "@/lib/email-templates";
import { lodgeOrderBy } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";

export const EMAIL_MESSAGE_SETTINGS_ID = "default";
const FALLBACK_PUBLIC_URL = "http://localhost:3000";

export interface EmailMessageSettings {
  clubName: string;
  bookingsName: string;
  lodgeName: string;
  emailFromName: string;
  supportEmail: string;
  contactEmail: string;
  publicUrl: string;
  lodgeTravelNote: string;
  doorCode: string | null;
}

// Persisted club-level fields only. Lodge identity (lodgeName, lodgeTravelNote,
// doorCode) was dropped from this singleton — email identity now always resolves
// from the Lodge table (see loadEmailMessageSettingsForLodge below).
export interface PersistedEmailMessageSettings {
  clubName: string | null;
  bookingsName: string | null;
  emailFromName: string | null;
  supportEmail: string | null;
  contactEmail: string | null;
  publicUrl: string | null;
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizeEmailMessagePublicUrl(
  value: string | null | undefined,
): string | null {
  const trimmed = trimOptional(value);
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
  } catch {
    return null;
  }

  return trimmed.replace(/\/+$/, "");
}

function getDefaultEmailMessageSettings(): EmailMessageSettings {
  const clubName = clubConfig.name;
  const publicUrl =
    normalizeEmailMessagePublicUrl(process.env.NEXTAUTH_URL) ??
    normalizeEmailMessagePublicUrl(clubConfig.publicUrl) ??
    FALLBACK_PUBLIC_URL;
  return {
    clubName,
    bookingsName: `${clubName} - Bookings`,
    lodgeName: `${clubName} Lodge`,
    emailFromName: clubConfig.emailFromName,
    supportEmail: clubConfig.supportEmail,
    contactEmail: clubConfig.contactEmail ?? clubConfig.supportEmail,
    publicUrl,
    lodgeTravelNote:
      clubConfig.lodgeTravelNote ?? "Please allow adequate travel time.",
    doorCode: null,
  };
}

export function normalizeEmailMessageSettings(
  persisted?: Partial<PersistedEmailMessageSettings> | null,
): EmailMessageSettings {
  const defaults = getDefaultEmailMessageSettings();
  // Lodge identity is no longer persisted here; it resolves from the Lodge table
  // via loadEmailMessageSettingsForLodge. Callers that need real lodge identity
  // go through the load functions; this normaliser returns config defaults for
  // the lodge fields.
  return {
    clubName: trimOptional(persisted?.clubName) ?? defaults.clubName,
    bookingsName: trimOptional(persisted?.bookingsName) ?? defaults.bookingsName,
    lodgeName: defaults.lodgeName,
    emailFromName:
      trimOptional(persisted?.emailFromName) ?? defaults.emailFromName,
    supportEmail: trimOptional(persisted?.supportEmail) ?? defaults.supportEmail,
    contactEmail: trimOptional(persisted?.contactEmail) ?? defaults.contactEmail,
    publicUrl:
      normalizeEmailMessagePublicUrl(persisted?.publicUrl) ?? defaults.publicUrl,
    lodgeTravelNote: defaults.lodgeTravelNote,
    doorCode: defaults.doorCode,
  };
}

export async function loadPersistedEmailMessageSettings(): Promise<
  PersistedEmailMessageSettings | null
> {
  const delegate = (prisma as unknown as {
    emailMessageSetting?: {
      findUnique: (args: unknown) => Promise<PersistedEmailMessageSettings | null>;
    };
  }).emailMessageSetting;

  if (!delegate) return null;

  try {
    return await delegate.findUnique({
      where: { id: EMAIL_MESSAGE_SETTINGS_ID },
    });
  } catch {
    return null;
  }
}

type LodgeIdentityRow = {
  name: string;
  travelNote: string | null;
  doorCode: string | null;
};

/**
 * Resolve the lodge whose identity an email should carry. An explicit lodgeId is
 * looked up directly; a falsy id, or a lookup that misses, falls back to the
 * club's DEFAULT lodge — the Lodge.isDefault flag, else oldest active, else
 * oldest of any state. That resolution mirrors `getDefaultLodgeId` in lodges.ts
 * (see its MIRROR CONTRACT comment) and the SQL `default_lodge_id()` function
 * (replaced in migration 20260709120000), so email identity and the column
 * DEFAULT always resolve the same lodge.
 *
 * Returns null when no Lodge row exists (fresh pre-seed install), when the DB is
 * unreachable (vitest runs with an unreachable DATABASE_URL), or when the lodge
 * delegate is absent — the caller then falls back to config defaults instead of
 * throwing.
 */
async function resolveLodgeIdentity(
  lodgeId: string | null | undefined,
): Promise<LodgeIdentityRow | null> {
  const delegate = (prisma as unknown as {
    lodge?: {
      findUnique: (args: unknown) => Promise<LodgeIdentityRow | null>;
      findFirst: (args: unknown) => Promise<LodgeIdentityRow | null>;
    };
  }).lodge;

  if (!delegate) return null;

  const select = { name: true, travelNote: true, doorCode: true } as const;

  try {
    if (lodgeId) {
      const lodge = await delegate.findUnique({ where: { id: lodgeId }, select });
      if (lodge) return lodge;
    }
    return (
      (await delegate.findFirst({
        where: { isDefault: true },
        select,
      })) ??
      (await delegate.findFirst({
        where: { active: true },
        orderBy: lodgeOrderBy(),
        select,
      })) ??
      (await delegate.findFirst({
        orderBy: lodgeOrderBy(),
        select,
      }))
    );
  } catch {
    return null;
  }
}

/**
 * Single resolution path for email lodge identity (multi-lodge). Club-level
 * fields come from the EmailMessageSetting singleton; lodge identity (name,
 * travel note, door code) always resolves from the Lodge table — the explicit
 * lodgeId when given, otherwise the club's default lodge. When no Lodge row can
 * be resolved (fresh pre-seed install or unreachable DB) the config defaults
 * stand in. The door code is strictly the resolved lodge's own — never leaked
 * from another lodge.
 */
export async function loadEmailMessageSettingsForLodge(
  lodgeId: string | null | undefined,
): Promise<EmailMessageSettings> {
  // Independent lookups — run per outgoing email, so don't serialise them.
  const [persisted, lodge] = await Promise.all([
    loadPersistedEmailMessageSettings(),
    resolveLodgeIdentity(lodgeId),
  ]);
  const base = normalizeEmailMessageSettings(persisted);
  const defaults = getDefaultEmailMessageSettings();

  if (!lodge) return base;

  return {
    ...base,
    lodgeName: trimOptional(lodge.name) ?? defaults.lodgeName,
    lodgeTravelNote: trimOptional(lodge.travelNote) ?? defaults.lodgeTravelNote,
    doorCode: trimOptional(lodge.doorCode),
  };
}

export async function loadEmailMessageSettings(): Promise<EmailMessageSettings> {
  // Delegate so every caller gets lodge-resolved identity (default lodge when no
  // lodgeId is in scope).
  return loadEmailMessageSettingsForLodge(null);
}

export function buildEmailTemplateGlobalData(settings: EmailMessageSettings) {
  return {
    CLUB_NAME: settings.clubName,
    CLUB_BOOKINGS_NAME: settings.bookingsName,
    CLUB_LODGE_NAME: settings.lodgeName,
    CLUB_EMAIL_FROM_NAME: settings.emailFromName,
    SUPPORT_EMAIL: settings.supportEmail,
    CONTACT_EMAIL: settings.contactEmail,
    BASE_URL: settings.publicUrl,
    CLUB_LODGE_TRAVEL_NOTE: settings.lodgeTravelNote,
  };
}

function replaceAll(value: string, search: string, replacement: string): string {
  if (!search || search === replacement) return value;
  return value.split(search).join(replacement);
}

export function applyEmailMessageSettingsToSubject(
  subject: string,
  settings: EmailMessageSettings,
): string {
  const defaults = getDefaultEmailMessageSettings();
  const replacements: Array<[string | undefined, string]> = [
    [defaults.clubName, settings.clubName],
    [defaults.bookingsName, settings.bookingsName],
    [defaults.lodgeName, settings.lodgeName],
    [defaults.emailFromName, settings.emailFromName],
    [process.env.EMAIL_FROM_NAME, settings.emailFromName],
    [defaults.supportEmail, settings.supportEmail],
    [process.env.SUPPORT_EMAIL, settings.supportEmail],
    [defaults.contactEmail, settings.contactEmail],
    [process.env.CONTACT_EMAIL, settings.contactEmail],
    [defaults.publicUrl, settings.publicUrl],
    [process.env.NEXTAUTH_URL?.replace(/\/+$/, ""), settings.publicUrl],
    [defaults.lodgeTravelNote, settings.lodgeTravelNote],
  ];

  return replacements.reduce(
    (current, [search, replacement]) =>
      replaceAll(current, search ?? "", replacement),
    subject,
  );
}

export function applyEmailMessageSettingsToHtml(
  html: string,
  settings: EmailMessageSettings,
): string {
  const defaults = getDefaultEmailMessageSettings();
  const replacements: Array<[string | undefined, string]> = [
    [defaults.clubName, settings.clubName],
    [defaults.bookingsName, settings.bookingsName],
    [defaults.lodgeName, settings.lodgeName],
    [defaults.emailFromName, settings.emailFromName],
    [process.env.EMAIL_FROM_NAME, settings.emailFromName],
    [defaults.supportEmail, settings.supportEmail],
    [process.env.SUPPORT_EMAIL, settings.supportEmail],
    [defaults.contactEmail, settings.contactEmail],
    [process.env.CONTACT_EMAIL, settings.contactEmail],
    [defaults.publicUrl, settings.publicUrl],
    [process.env.NEXTAUTH_URL?.replace(/\/+$/, ""), settings.publicUrl],
    [defaults.lodgeTravelNote, settings.lodgeTravelNote],
  ];

  return replacements.reduce(
    (current, [search, replacement]) =>
      replaceAll(current, escapeHtml(search ?? ""), escapeHtml(replacement)),
    html,
  );
}

export function formatEmailFromAddressWithSettings(
  settings: EmailMessageSettings,
  fromAddress?: string,
): string {
  const address = fromAddress || process.env.EMAIL_FROM || settings.supportEmail;
  const fromName = settings.emailFromName.replace(/[\r\n]+/g, " ").trim();
  return `"${fromName.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${address}>`;
}
