import { clubConfig } from "@/config/club";
import type { ClubIdentity } from "@/config/club-identity-types";
import { FALLBACK_LODGE_CAPACITY } from "@/lib/lodge-capacity";

export const CLUB_NAME = clubConfig.name;
const CLUB_SHORT_NAME = clubConfig.shortName ?? clubConfig.name;
export const CLUB_SUPPORT_EMAIL = clubConfig.supportEmail;
export const CLUB_CONTACT_EMAIL = clubConfig.contactEmail ?? clubConfig.supportEmail;
export const CLUB_PUBLIC_URL = clubConfig.publicUrl;
export const CLUB_EMAIL_FROM_NAME = clubConfig.emailFromName;
export const CLUB_LODGE_TRAVEL_NOTE =
  clubConfig.lodgeTravelNote ?? "Please allow adequate travel time.";
export const CLUB_HUT_LEADER_LABEL = clubConfig.hutLeaderLabel ?? "Hut Leader";
const CLUB_SOCIAL_LINKS = clubConfig.socialLinks ?? {};
export const CLUB_FACEBOOK_URL = CLUB_SOCIAL_LINKS.facebook;
export const CLUB_BOOKINGS_NAME = `${clubConfig.name} - Bookings`;
// CLUB_LODGE_NAME was retired here (E3 #1929): the lodge display name is now
// DB-first (the default Lodge.name, resolved via club-identity-settings.ts).
// The `lodgeName` field on the clubIdentity object below stays the config-
// derived fallback used only when no Lodge row resolves. Email subject builders
// that need the STABLE config lodge-name search key import EMAIL_DEFAULT_LODGE_NAME
// from email-message-settings.ts instead.
const CLUB_LODGE_NAME_FALLBACK = `${clubConfig.name} Lodge`;
const CLUB_PUBLIC_HOST = new URL(clubConfig.publicUrl).host;
const CLUB_EMAIL_DOMAIN = CLUB_PUBLIC_HOST.replace(/^www\./, "");

export const clubIdentity: ClubIdentity = {
  name: CLUB_NAME,
  shortName: CLUB_SHORT_NAME,
  supportEmail: CLUB_SUPPORT_EMAIL,
  contactEmail: CLUB_CONTACT_EMAIL,
  publicUrl: CLUB_PUBLIC_URL,
  emailFromName: CLUB_EMAIL_FROM_NAME,
  lodgeTravelNote: CLUB_LODGE_TRAVEL_NOTE,
  hutLeaderLabel: CLUB_HUT_LEADER_LABEL,
  socialLinks: CLUB_SOCIAL_LINKS,
  bookingsName: CLUB_BOOKINGS_NAME,
  lodgeName: CLUB_LODGE_NAME_FALLBACK,
  publicHost: CLUB_PUBLIC_HOST,
  lodgeCapacity: FALLBACK_LODGE_CAPACITY,
};

export function clubDomainEmail(localPart: string): string {
  return `${localPart}@${CLUB_EMAIL_DOMAIN}`;
}
