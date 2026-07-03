// Demo-seed personas (prisma/demo-seed.ts). Passwords come from the seed's
// DEMO_SEED_PASSWORD default; override E2E_DEMO_PASSWORD if the seed was run
// with a custom one.
export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? "demo1234";

export type Persona = {
  email: string;
  firstName: string;
  lastName: string;
};

export const personas = {
  // Alice has a PAID subscription, so she can book at member rates. The
  // booking and Stripe payment specs all book as Alice on disjoint stay
  // windows (see stay-dates.ts).
  booker: {
    email: "alice@demo.alpineclub.test",
    firstName: "Alice",
    lastName: "Anderson",
  },
  // Bob starts un-enrolled in two-factor auth on a fresh demo seed, so the
  // two-factor spec can drive real enrollment. His UNPAID subscription does
  // not matter for login.
  enrollee: {
    email: "bob@demo.alpineclub.test",
    firstName: "Bob",
    lastName: "Brown",
  },
} satisfies Record<string, Persona>;
