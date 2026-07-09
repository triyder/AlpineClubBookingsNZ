import { describe, expect, it, vi } from "vitest";
import {
  canModifyBookingStatusForRole,
  getBookingEditPolicy,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";

describe("booking edit policy", () => {
  it("allows members to modify only active booking lifecycle statuses", () => {
    expect(canModifyBookingStatusForRole("PENDING", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("CONFIRMED", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("PAID", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("COMPLETED", "MEMBER")).toBe(true);
    expect(canModifyBookingStatusForRole("DRAFT", "MEMBER")).toBe(false);
    expect(canModifyBookingStatusForRole("WAITLISTED", "MEMBER")).toBe(false);
  });

  it("allows admins to modify the additional future-booking statuses from phase 1", () => {
    expect(canModifyBookingStatusForRole("DRAFT", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("WAITLISTED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("WAITLIST_OFFERED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("BUMPED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatusForRole("CANCELLED", "ADMIN")).toBe(false);
    expect(canModifyBookingStatusForRole("COMPLETED", "ADMIN")).toBe(true);
  });

  it("marks only active booking states for the full capacity/payment lifecycle", () => {
    expect(usesActiveBookingEditLifecycle("PENDING")).toBe(true);
    expect(usesActiveBookingEditLifecycle("CONFIRMED")).toBe(true);
    expect(usesActiveBookingEditLifecycle("PAID")).toBe(true);
    expect(usesActiveBookingEditLifecycle("COMPLETED")).toBe(true);
    expect(usesActiveBookingEditLifecycle("DRAFT")).toBe(false);
    expect(usesActiveBookingEditLifecycle("WAITLISTED")).toBe(false);
  });

  it("allows in-progress paid/completed stays from NZ tomorrow while locking check-in", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));

    const paidPolicy = getBookingEditPolicy({
      status: "PAID",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
    });
    expect(paidPolicy.canModify).toBe(true);
    expect(paidPolicy.mode).toBe("in-progress");
    expect(paidPolicy.editableFrom?.toISOString().slice(0, 10)).toBe("2026-08-22");
    expect(paidPolicy.checkInEditable).toBe(false);

    const completedPolicy = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
    });
    expect(completedPolicy.canModify).toBe(true);
    expect(completedPolicy.mode).toBe("in-progress");

    vi.useRealTimers();
  });

  it("locks fully past completed stays", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const policy = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-24T00:00:00.000Z"),
    });

    expect(policy.canModify).toBe(false);
    expect(policy.mode).toBeNull();

    vi.useRealTimers();
  });
});

describe("booking edit policy — admin override (issue #1668)", () => {
  // Anchor "now" mid-stay for the in-progress case, well after the fully-past
  // stays so those refuse without the flag.
  const IN_PROGRESS = {
    checkIn: new Date("2026-08-20T00:00:00.000Z"),
    checkOut: new Date("2026-08-24T00:00:00.000Z"),
  };
  const FULLY_PAST = {
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-05T00:00:00.000Z"),
  };

  it("unlocks an in-progress PAID stay for an admin override", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));

    const withOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...IN_PROGRESS,
      adminOverride: true,
    });
    expect(withOverride.canModify).toBe(true);
    expect(withOverride.mode).toBe("admin-override");
    expect(withOverride.checkInEditable).toBe(true);
    expect(withOverride.editableFrom).toBeNull();

    // Same inputs WITHOUT the flag stay the in-progress branch (check-in locked).
    const withoutOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...IN_PROGRESS,
    });
    expect(withoutOverride.mode).toBe("in-progress");
    expect(withoutOverride.checkInEditable).toBe(false);

    vi.useRealTimers();
  });

  it("unlocks a fully-past COMPLETED stay for an admin override", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const withOverride = getBookingEditPolicy({
      status: "COMPLETED",
      role: "ADMIN",
      ...FULLY_PAST,
      adminOverride: true,
    });
    expect(withOverride.canModify).toBe(true);
    expect(withOverride.mode).toBe("admin-override");
    expect(withOverride.checkInEditable).toBe(true);

    // Pin the fully-past non-override refusal for the same inputs.
    const withoutOverride = getBookingEditPolicy({
      status: "COMPLETED",
      role: "ADMIN",
      ...FULLY_PAST,
    });
    expect(withoutOverride.canModify).toBe(false);
    expect(withoutOverride.mode).toBeNull();

    vi.useRealTimers();
  });

  it("unlocks a fully-past PAID stay for an admin override", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const withOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...FULLY_PAST,
      adminOverride: true,
    });
    expect(withOverride.canModify).toBe(true);
    expect(withOverride.mode).toBe("admin-override");
    expect(withOverride.checkInEditable).toBe(true);

    const withoutOverride = getBookingEditPolicy({
      status: "PAID",
      role: "ADMIN",
      ...FULLY_PAST,
    });
    expect(withoutOverride.canModify).toBe(false);
    expect(withoutOverride.mode).toBeNull();

    vi.useRealTimers();
  });

  it("ignores the override flag for a non-admin role (byte-for-byte fall-through)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const withFlag = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      ...FULLY_PAST,
      adminOverride: true,
    });
    const withoutFlag = getBookingEditPolicy({
      status: "COMPLETED",
      role: "MEMBER",
      ...FULLY_PAST,
    });
    expect(withFlag).toEqual(withoutFlag);
    expect(withFlag.canModify).toBe(false);
    expect(withFlag.mode).toBeNull();

    vi.useRealTimers();
  });

  it("still refuses an override for an ineligible status (CANCELLED)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T12:00:00.000Z"));

    const policy = getBookingEditPolicy({
      status: "CANCELLED",
      role: "ADMIN",
      ...FULLY_PAST,
      adminOverride: true,
    });
    expect(policy.canModify).toBe(false);
    expect(policy.mode).toBeNull();
    expect(policy.reason).toBe(
      "This booking cannot be modified in its current status",
    );

    vi.useRealTimers();
  });
});
