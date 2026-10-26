/**
 * #4170: the instruction in the alert for a late capture refunded outside the
 * app - one sentence shared by the hand-built HTML
 * (`email-templates/admin-late-capture-outside-app.ts`) and the
 * `{{outsideAppRefundNote}}` token an admin's saved body renders, so the two
 * cannot say different things about money. A leaf module: the registry imports
 * it without loading the email layout.
 */
export const LATE_CAPTURE_REFUNDED_OUTSIDE_APP_NOTE =
  "The app has no record of this refund and has raised no Xero credit note for it, because Xero never received this payment. " +
  "Check the refund in Stripe, and record it in Xero by hand only if the payment was recorded there.";
