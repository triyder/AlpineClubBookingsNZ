- **Setup wizards save the step you are on in order (#4014).** The Xero,
  Stripe, Google and Lobby Display setup wizards remember which step you were
  on, so a return from a provider's sign-in page picks up where you were. Two
  quick step changes could rarely save those positions out of order, so the Xero
  wizard could come back from connecting one step behind; this was seen in the
  automated browser tests. The wizard now sends its position saves one at a
  time and keeps the last one alive when you leave for the provider's page.
  Nothing about what each step checks has changed.
