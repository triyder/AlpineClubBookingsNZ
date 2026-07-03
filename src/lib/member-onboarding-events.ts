// Browser event raised when the member-onboarding wizard completes
// successfully. Pages that cached bookability-sensitive data before the
// confirmation (the /book family list) listen for it to refetch, because the
// wizard overlays them from the authenticated layout and closes without a
// navigation.
export const MEMBER_ONBOARDING_CONFIRMED_EVENT = "member-onboarding-confirmed";

export function emitMemberOnboardingConfirmed() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(MEMBER_ONBOARDING_CONFIRMED_EVENT));
}
