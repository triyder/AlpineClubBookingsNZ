- **A saved-card charge from the officer's "confirm pending guests" button or
  the charge-saved-method route now includes a change fee recorded on the
  booking (#4357).** The overnight confirm job already charged the price plus
  the fee. These two charged the price alone, so when an unpaid booking carried
  a change fee, the card was charged short and the booking could not be
  settled: the money was taken, but the booking stayed confirmed and unpaid
  until an officer stepped in. All three now charge the same amount, and the
  officer's confirm dialog and the confirmation email quote it. A booking whose
  price is $0 but which still carries a change fee is now charged the fee,
  instead of being confirmed free.
