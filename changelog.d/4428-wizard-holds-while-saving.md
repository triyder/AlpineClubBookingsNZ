- **Setup wizards wait for a save to finish before letting you move on
  (#4410).** While a step in the Xero, Stripe, Google, backup or display setup
  wizard is still saving, Continue, Back and the other steps are briefly
  disabled. Before, replacing the Xero credentials and pressing Connect straight
  away could let the save finish during the connection and undo it, leaving
  Xero showing Not Connected.
