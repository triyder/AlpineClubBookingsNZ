- **Booking confirmation emails now carry add-to-calendar links (fork #35).**
  The confirmation lists three links for the stay: a calendar file (`.ics`)
  download that works in Apple Calendar and most other apps, and one-click
  "add this event" links for Google Calendar and Outlook. Each puts the stay
  in the recipient's calendar as all-day entries from check-in through the
  checkout day — no times, matching how lodge nights work. The download link
  carries its own signed key, so it works from the email without signing in,
  and it stops working if the booking is later cancelled or bumped. Clubs that
  edit the Booking Confirmed template control the section with the new
  `{{ical}}` token; existing saved overrides are unaffected until an admin
  chooses to add it.
