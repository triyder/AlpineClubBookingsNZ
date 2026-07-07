import { describe, expect, it } from "vitest";
import {
  getDisabledFeatureForPath,
  getRequiredFeaturesForPath,
  isFeatureHrefVisible,
} from "@/config/feature-routes";
import { MODULE_KEYS, getEffectiveModuleFlags } from "@/config/modules";
import type { FeatureFlags } from "@/config/schema";

const allOn = Object.fromEntries(
  MODULE_KEYS.map((key) => [key, true]),
) as FeatureFlags;

describe("feature route map", () => {
  it("maps optional module routes to the expected feature flags", () => {
    expect(getRequiredFeaturesForPath("/lodge/kiosk")).toEqual(["kiosk"]);
    expect(getRequiredFeaturesForPath("/admin/chores")).toEqual(["chores"]);
    expect(getRequiredFeaturesForPath("/finance")).toEqual([
      "financeDashboard",
    ]);
    expect(
      getRequiredFeaturesForPath("/api/admin/setup/finance-report-mappings")
    ).toEqual(["financeDashboard"]);
    expect(getRequiredFeaturesForPath("/admin/waitlist")).toEqual(["waitlist"]);
    expect(getRequiredFeaturesForPath("/admin/xero/records")).toEqual([
      "xeroIntegration",
    ]);
    expect(getRequiredFeaturesForPath("/admin/internet-banking")).toEqual([
      "xeroIntegration",
      "internetBankingPayments",
    ]);
    expect(
      getRequiredFeaturesForPath("/api/admin/internet-banking-settings")
    ).toEqual(["xeroIntegration", "internetBankingPayments"]);
    expect(getRequiredFeaturesForPath("/api/address-autocomplete/search")).toEqual([
      "addressAutocomplete",
    ]);
    expect(
      getRequiredFeaturesForPath("/api/address-autocomplete/details/123")
    ).toEqual(["addressAutocomplete"]);
  });

  it("requires both kiosk and chores for lodge roster routes", () => {
    expect(getRequiredFeaturesForPath("/lodge/roster/2026-07-01")).toEqual([
      "kiosk",
      "chores",
    ]);
  });

  it("maps the newer toggleable module routes to their flags", () => {
    expect(getRequiredFeaturesForPath("/api/group-bookings")).toEqual([
      "groupBookings",
    ]);
    expect(getRequiredFeaturesForPath("/admin/lockers")).toEqual(["lockers"]);
    expect(getRequiredFeaturesForPath("/admin/induction")).toEqual([
      "induction",
    ]);
    expect(getRequiredFeaturesForPath("/induction")).toEqual(["induction"]);
    expect(getRequiredFeaturesForPath("/admin/work-parties")).toEqual([
      "workParties",
    ]);
    expect(getRequiredFeaturesForPath("/admin/promo-codes")).toEqual([
      "promoCodes",
    ]);
    expect(getRequiredFeaturesForPath("/admin/hut-leaders")).toEqual([
      "hutLeaders",
    ]);
    expect(getRequiredFeaturesForPath("/admin/communications")).toEqual([
      "communications",
    ]);
    expect(getRequiredFeaturesForPath("/api/skifield-whakapapa")).toEqual([
      "skifieldConditions",
    ]);
    expect(getRequiredFeaturesForPath("/admin/lodges")).toEqual([
      "multiLodge",
    ]);
  });

  it("blocks each new module's pages AND api routes when it is off", () => {
    // Both a page and an API route 404 when the module is disabled — i.e. an
    // off module is fully gated, not just hidden in the UI.
    expect(
      getDisabledFeatureForPath("/admin/lockers", { ...allOn, lockers: false })
    ).toBe("lockers");
    expect(
      getDisabledFeatureForPath("/api/admin/lockers", {
        ...allOn,
        lockers: false,
      })
    ).toBe("lockers");
    expect(
      getDisabledFeatureForPath("/api/group-bookings/abc/join", {
        ...allOn,
        groupBookings: false,
      })
    ).toBe("groupBookings");
    expect(
      getDisabledFeatureForPath("/api/promo-codes/validate", {
        ...allOn,
        promoCodes: false,
      })
    ).toBe("promoCodes");
    // Multi-lodge: the lodge admin page and its API both 404 when off.
    expect(
      getDisabledFeatureForPath("/admin/lodges", {
        ...allOn,
        multiLodge: false,
      })
    ).toBe("multiLodge");
    expect(
      getDisabledFeatureForPath("/api/admin/lodges", {
        ...allOn,
        multiLodge: false,
      })
    ).toBe("multiLodge");
    expect(
      getDisabledFeatureForPath("/api/admin/lodges/lodge-1", {
        ...allOn,
        multiLodge: false,
      })
    ).toBe("multiLodge");
    expect(
      getDisabledFeatureForPath("/api/address-autocomplete/search", {
        ...allOn,
        addressAutocomplete: false,
      })
    ).toBe("addressAutocomplete");
  });

  it("detects the disabled feature for protected route and API paths", () => {
    expect(
      getDisabledFeatureForPath("/api/bookings/booking-1/waitlist-confirm", {
        ...allOn,
        waitlist: false,
      })
    ).toBe("waitlist");
    expect(
      getDisabledFeatureForPath("/api/admin/members/member-1/xero-link", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe("xeroIntegration");
    expect(
      getDisabledFeatureForPath("/admin/internet-banking", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe("xeroIntegration");
    expect(
      getDisabledFeatureForPath("/admin/internet-banking", {
        ...allOn,
        internetBankingPayments: false,
      })
    ).toBe("internetBankingPayments");
    expect(
      getDisabledFeatureForPath("/api/admin/internet-banking-settings", {
        ...allOn,
        internetBankingPayments: false,
      })
    ).toBe("internetBankingPayments");
    expect(
      getDisabledFeatureForPath(
        "/api/admin/setup/finance-report-mappings/backfill",
        { ...allOn, financeDashboard: false }
      )
    ).toBe("financeDashboard");
    expect(
      isFeatureHrefVisible("/admin/xero#xero-section-mappings", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe(false);
  });

  it("uses the admin module toggle for effective state", () => {
    // Admin off → disabled.
    expect(
      getDisabledFeatureForPath(
        "/admin/waitlist",
        getEffectiveModuleFlags({ ...allOn, waitlist: false })
      )
    ).toBe("waitlist");
    // Admin on → enabled.
    expect(
      getDisabledFeatureForPath(
        "/admin/waitlist",
        getEffectiveModuleFlags({ ...allOn, waitlist: true })
      )
    ).toBeNull();
  });

  it("does not match shared booking APIs or similar prefixes", () => {
    expect(getRequiredFeaturesForPath("/api/bookings")).toEqual([]);
    expect(getRequiredFeaturesForPath("/financex")).toEqual([]);
  });

  it("never gates booking creation on the multiLodge flag", () => {
    // multiLodge only guards the admin lodges surface. Core booking creation
    // (and reads) must work whether or not the club runs multiple lodges, so
    // no booking route requires the flag and disabling it never 404s a
    // booking. A `/admin/lodges`-lookalike prefix must not catch bookings.
    expect(getRequiredFeaturesForPath("/api/bookings")).not.toContain(
      "multiLodge"
    );
    expect(getRequiredFeaturesForPath("/api/bookings/booking-1")).not.toContain(
      "multiLodge"
    );
    expect(
      getDisabledFeatureForPath("/api/bookings", { ...allOn, multiLodge: false })
    ).toBeNull();
    expect(
      getDisabledFeatureForPath("/api/bookings/booking-1", {
        ...allOn,
        multiLodge: false,
      })
    ).toBeNull();
    // The admin bookings surface is likewise never behind multiLodge.
    expect(
      getDisabledFeatureForPath("/admin/bookings", {
        ...allOn,
        multiLodge: false,
      })
    ).toBeNull();
  });

  it("supports nav filtering with query strings", () => {
    expect(
      isFeatureHrefVisible("/admin/waitlist?status=WAITLISTED", {
        ...allOn,
        waitlist: false,
      })
    ).toBe(false);
    expect(isFeatureHrefVisible("/admin/bookings", allOn)).toBe(true);
    expect(
      isFeatureHrefVisible("/admin/internet-banking", {
        ...allOn,
        xeroIntegration: false,
      })
    ).toBe(false);
    expect(
      isFeatureHrefVisible("/admin/internet-banking", {
        ...allOn,
        internetBankingPayments: false,
      })
    ).toBe(false);
    expect(isFeatureHrefVisible("/admin/internet-banking", allOn)).toBe(true);
  });
});
