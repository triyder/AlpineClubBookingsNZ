- **Keyboard focus now stays in the list after a minimum-stay policy or
  date-specific period is activated, deactivated or deleted (#4116).** These
  buttons reload the list, which used to drop keyboard and screen-reader users
  to the top of the page. Activate and Deactivate now keep focus on the same
  row's button. Delete moves focus to an Edit button, never to a button that
  would change something on a stray key press: the same policy's Edit for a
  minimum-stay policy (which stays listed as inactive), and the next period's
  Edit for a date-specific period (the previous one's for the last period). If
  that row is gone, or the list could not be reloaded, focus goes to the card.
  A delete that fails returns focus to the row it was pressed on. Each row's
  buttons now also announce which policy or period they belong to. Nothing
  needs configuring.
