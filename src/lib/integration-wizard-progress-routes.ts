/**
 * Which route stores which setup wizard's resume cursor (#2080, #4409). One
 * map, read by the client hook (where to fetch) and by each route (which ids it
 * accepts), so a wizard can never be sent to a route that refuses it.
 *
 * Each route carries its OWN literal permission gate, from the area its path
 * already belongs to: the integrations route is finance (Xero, Stripe, Google
 * and - by owner decision, 28 Jul 2026 - the lodge display wizard); the backups
 * route is support, the area of `/admin/backups` (owner decision, #4409,
 * 26 Oct 2026: the Backups wizard remembers its step like the others).
 *
 * Client-safe: no server imports.
 */
export const WIZARD_PROGRESS_ROUTES = {
  integrations: {
    path: "/api/admin/integrations/wizard-progress",
    wizardIds: ["xero", "stripe", "google", "display"],
  },
  backups: {
    path: "/api/admin/backups/wizard-progress",
    wizardIds: ["backup"],
  },
} as const;

type WizardProgressRoute = (typeof WIZARD_PROGRESS_ROUTES)[keyof typeof WIZARD_PROGRESS_ROUTES];

/** The route that stores this wizard's cursor; the integrations route for an id no route lists. */
export function wizardProgressPath(wizardId: string): string {
  const route = Object.values(WIZARD_PROGRESS_ROUTES).find((candidate: WizardProgressRoute) =>
    (candidate.wizardIds as readonly string[]).includes(wizardId),
  );
  return (route ?? WIZARD_PROGRESS_ROUTES.integrations).path;
}
