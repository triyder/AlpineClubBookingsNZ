- **On a booking edit, the promo code box uses the prices the guests already
  paid (#4202).** When a booking is edited, every night a guest already holds
  keeps the price it was sold at, and only nights the edit adds are priced at
  today's rates. The promo code box on the booking editor used to price every
  night at today's rates instead, so once the club's rates had changed since
  the booking was made it could show a different discount from the price
  summary beside it. It now prices the booking the same way as the price
  summary and the save, so the two show the same discount. When an officer
  ticks or unticks a guest as another club's member, or links a placeholder
  guest to a member, the box now re-prices that guest as the summary does. On a
  school's booking the box now refuses a code that benefits the person who made
  the booking, with the summary's message, where it used to judge the code
  against the officer editing it.

  Behind the scenes, the server now answers an edit's promo check for the
  booking itself whatever the request says, as the price summary does: against
  the booking's owner rather than any other member named, at the booking's own
  lodge, and with the club's "group discount on later edits" setting. The
  booking editor already sent those, so they change nothing on screen; they
  matter for anything calling the check directly. The check also no longer
  counts the booking's own use of a code against the code's use limits, which
  the price summary never did; on screen that only shows when a code the
  booking already carries is checked again with a different choice of guests.

  What a member is charged does not change: that always came from the price
  summary. The box on a new booking is unchanged.
