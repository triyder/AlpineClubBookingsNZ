import { afterEach, describe, expect, it, vi } from "vitest";

import { clubConfig } from "@/config/club";
import {
  EMAIL_DEFAULT_LODGE_NAME,
  applyEmailMessageSettingsToHtml,
  applyEmailMessageSettingsToSubject,
  normalizeEmailMessageSettings,
  type EmailMessageSettings,
} from "@/lib/email-message-settings";

describe("email club-name precedence (E3 #1929)", () => {
  it("uses ClubIdentitySettings.name when there is no EmailMessageSetting.clubName", () => {
    const settings = normalizeEmailMessageSettings(null, "DB Identity Club");
    expect(settings.clubName).toBe("DB Identity Club");
  });

  it("an explicit EmailMessageSetting.clubName still wins over the DB identity", () => {
    const settings = normalizeEmailMessageSettings(
      { clubName: "Explicit Email Club" },
      "DB Identity Club",
    );
    expect(settings.clubName).toBe("Explicit Email Club");
  });

  it("falls back to club.json when neither is set", () => {
    const settings = normalizeEmailMessageSettings(null, null);
    expect(settings.clubName).toBe(clubConfig.name);
  });

  it("keeps the default lodge-name search key config-derived (stable)", () => {
    expect(EMAIL_DEFAULT_LODGE_NAME).toBe(`${clubConfig.name} Lodge`);
  });
});

describe("cron check-in subject renders the DB lodge name", () => {
  it("replaces the config lodge-name key with the resolved lodge name", () => {
    // Mirrors cron-checkin-reminders.ts:74 / email/booking.ts checkin subject.
    const subject = `Check-in Reminder - ${EMAIL_DEFAULT_LODGE_NAME}`;
    const settings = {
      clubName: clubConfig.name,
      bookingsName: `${clubConfig.name} - Bookings`,
      lodgeName: "Renamed DB Lodge",
      emailFromName: clubConfig.emailFromName,
      supportEmail: clubConfig.supportEmail,
      contactEmail: clubConfig.contactEmail ?? clubConfig.supportEmail,
      publicUrl: clubConfig.publicUrl,
      lodgeTravelNote: "note",
      doorCode: null,
    } satisfies EmailMessageSettings;
    expect(applyEmailMessageSettingsToSubject(subject, settings)).toBe(
      "Check-in Reminder - Renamed DB Lodge",
    );
  });
});

describe("removed email-identity env vars have no effect (C7 #1986)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("EMAIL_FROM_NAME / SUPPORT_EMAIL / CONTACT_EMAIL env values are no longer search keys", () => {
    // Post-removal these env vars are unread. Set them to sentinels and prove a
    // message carrying those values passes through untouched — email identity is
    // DB-first only, so the env value is never rewritten to the DB value.
    vi.stubEnv("EMAIL_FROM_NAME", "Sneaky Env From-Name");
    vi.stubEnv("SUPPORT_EMAIL", "env-support@example.com");
    vi.stubEnv("CONTACT_EMAIL", "env-contact@example.com");

    const settings = normalizeEmailMessageSettings({
      supportEmail: "db-support@example.org",
      contactEmail: "db-contact@example.org",
      emailFromName: "DB From-Name",
    });

    const envBody =
      "Sneaky Env From-Name env-support@example.com env-contact@example.com";
    expect(applyEmailMessageSettingsToSubject(envBody, settings)).toBe(envBody);
    expect(applyEmailMessageSettingsToHtml(envBody, settings)).toBe(envBody);
  });

  it("still rewrites the config-derived support/contact defaults to the live DB values", () => {
    // With the env terms gone, the config-derived defaults remain the stable
    // search keys, so delivered mail still shows the DB identity.
    vi.stubEnv("SUPPORT_EMAIL", "env-support@example.com");
    vi.stubEnv("CONTACT_EMAIL", "env-contact@example.com");

    const settings = normalizeEmailMessageSettings({
      supportEmail: "db-support@example.org",
      contactEmail: "db-contact@example.org",
    });

    const body = `${clubConfig.supportEmail} / ${clubConfig.contactEmail}`;
    expect(applyEmailMessageSettingsToSubject(body, settings)).toBe(
      "db-support@example.org / db-contact@example.org",
    );
  });
});
