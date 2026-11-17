import { type GuestData } from "@/components/guest-form";

// Moved out of `use-booking-wizard.ts` verbatim (fork sync, 17 Nov 2026: that
// file is past its hard size ceiling, #4926, and these are pure). The wizard is
// their one caller.

export function clearGuestStayRanges(guestList: GuestData[]): GuestData[] {
  return guestList.map((guest) => {
    const nextGuest = { ...guest };
    delete nextGuest.stayStart;
    delete nextGuest.stayEnd;
    return nextGuest;
  });
}

export function clearGuestNights(guestList: GuestData[]): GuestData[] {
  return guestList.map((guest) => {
    const nextGuest = { ...guest };
    delete nextGuest.nights;
    return nextGuest;
  });
}
