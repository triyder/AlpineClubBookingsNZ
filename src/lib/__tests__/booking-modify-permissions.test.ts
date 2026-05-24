import { describe, expect, it, vi } from "vitest";
import {
  canModifyBookingStatus,
  usesActiveBookingLifecycle,
} from "@/lib/booking-modify-permissions";
import { getBookingEditPolicy } from "@/lib/booking-edit-policy";

describe("booking modify permissions", () => {
  it("allows members to modify only active booking lifecycle statuses", () => {
    expect(canModifyBookingStatus("PENDING", "MEMBER")).toBe(true);
    expect(canModifyBookingStatus("CONFIRMED", "MEMBER")).toBe(true);
    expect(canModifyBookingStatus("PAID", "MEMBER")).toBe(true);
    expect(canModifyBookingStatus("COMPLETED", "MEMBER")).toBe(true);
    expect(canModifyBookingStatus("DRAFT", "MEMBER")).toBe(false);
    expect(canModifyBookingStatus("WAITLISTED", "MEMBER")).toBe(false);
  });

  it("allows admins to modify the additional future-booking statuses from phase 1", () => {
    expect(canModifyBookingStatus("DRAFT", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("WAITLISTED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("WAITLIST_OFFERED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("BUMPED", "ADMIN")).toBe(true);
    expect(canModifyBookingStatus("CANCELLED", "ADMIN")).toBe(false);
    expect(canModifyBookingStatus("COMPLETED", "ADMIN")).toBe(true);
  });

  it("marks only active booking states for the full capacity/payment lifecycle", () => {
    expect(usesActiveBookingLifecycle("PENDING")).toBe(true);
    expect(usesActiveBookingLifecycle("CONFIRMED")).toBe(true);
    expect(usesActiveBookingLifecycle("PAID")).toBe(true);
    expect(usesActiveBookingLifecycle("COMPLETED")).toBe(true);
    expect(usesActiveBookingLifecycle("DRAFT")).toBe(false);
    expect(usesActiveBookingLifecycle("WAITLISTED")).toBe(false);
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
