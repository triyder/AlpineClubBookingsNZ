import {
  canModifyBookingStatusForRole,
  usesActiveBookingEditLifecycle,
} from "@/lib/booking-edit-policy";

export function canModifyBookingStatus(status: string, role: string): boolean {
  return canModifyBookingStatusForRole(status, role);
}

export function usesActiveBookingLifecycle(status: string): boolean {
  return usesActiveBookingEditLifecycle(status);
}
