// Global test setup.
//
// The email layer (src/lib/email-delivery.ts) validates delivery configuration
// and refuses to build a transport — throwing "Email delivery is not
// configured" — when EMAIL_FROM or the SES credentials are absent. Unit tests
// mock nodemailer's transport, so no real mail is ever sent; these fake values
// exist only to satisfy that config gate, mirroring how CI supplies fake
// STRIPE_SECRET_KEY / XERO_ENCRYPTION_KEY values.
//
// EMAIL_FROM is set to CLUB_SUPPORT_EMAIL — the exact value email-sender.ts
// falls back to when EMAIL_FROM is unset — so the rendered "from" address is
// byte-for-byte identical to the previous (unset) behaviour and no test that
// asserts the sender address changes. Set with ??= so any test that deliberately
// exercises a different/!ok config by assigning or deleting these keeps control.
import { CLUB_SUPPORT_EMAIL } from "@/config/club-identity";

process.env.EMAIL_FROM ??= CLUB_SUPPORT_EMAIL;
process.env.AWS_SES_ACCESS_KEY_ID ??= "test-ses-access-key-id";
process.env.AWS_SES_SECRET_ACCESS_KEY ??= "test-ses-secret-access-key";
