import { describe, expect, it } from "vitest";

import { clubConfig } from "@/config/club";
import {
  EMAIL_DEFAULT_LODGE_NAME,
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
