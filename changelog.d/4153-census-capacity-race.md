- **The booking-ledger check now reads a booking cancelled because the dates
  filled up while the member was paying (#4147).** That cancellation refunds
  the card under its own refund record, which the check did not look at, so
  it could not explain the booking's money. A refund still being retried read
  as wrong, a refund that could not be planned in full could not be accounted
  for, and a refund whose retries had stopped was wrongly treated as
  explained. The check now reads that refund record by the same rule the
  booking page uses. A refund still being retried is shown as in progress.
  Any part of the charge the payment's records captured that the automatic
  refund did not cover is named as planned short, marked as a capacity race,
  for the officers to follow up; a charge the records never captured is
  reported as a separate gap in those records. A refund that can no longer
  be made is still reported as a disagreement. It also means the one-off
  job that writes old bookings into the ledger no longer refuses such a
  booking while its refund is still being retried.
