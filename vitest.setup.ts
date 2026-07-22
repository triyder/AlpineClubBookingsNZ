// Global test setup.
//
// The email layer (src/lib/email-delivery.ts) validates delivery configuration
// and refuses to build a transport — throwing "Email delivery is not
// configured" — when EMAIL_FROM or the SES credentials are absent. Unit tests
// mock nodemailer's transport, so no real mail is ever sent; these fake values
// exist only to satisfy that config gate, mirroring how CI supplies a fake
// STRIPE_SECRET_KEY value.
//
// EMAIL_FROM is set to SAFE_DEFAULT_CONFIG.supportEmail — the exact value
// email-sender.ts falls back to when EMAIL_FROM is unset (C6 #1985: the envelope
// sender is bootstrap-derived, never club.json) — so the rendered "from" address
// is byte-for-byte identical to the unset behaviour and no test that asserts the
// sender address changes. Set with ??= so any test that deliberately exercises a
// different/!ok config by assigning or deleting these keeps control.
import { vi } from "vitest";
import { SAFE_DEFAULT_CONFIG } from "@/config/club";

// `server-only` is a Next.js guard that throws when a module is imported outside
// a Server Component. Server-side libraries (e.g. member-photo.ts) legitimately
// import it; in the Vitest node environment the guard has no meaning, so stub it
// globally. Without this, any test that transitively imports a server-only
// module fails to load. Applies to all test files via setupFiles.
vi.mock("server-only", () => ({}));

process.env.EMAIL_FROM ??= SAFE_DEFAULT_CONFIG.supportEmail;
process.env.AWS_SES_ACCESS_KEY_ID ??= "test-ses-access-key-id";
process.env.AWS_SES_SECRET_ACCESS_KEY ??= "test-ses-secret-access-key";
