- **A price increase whose card request already belongs to another change of
  the same booking now reaches an administrator at once (#4081).** In a rare
  order, two changes to one booking can end up with the same card request
  recorded for the first. The automatic retry for the second used to be refused
  the same way on each of its five attempts, over about five hours and twenty
  minutes, before anyone was told. It now stops on the first refusal, keeps the money owed on
  record, and sends one alert that names the cause; the "Exhausted recovery
  operations" item on the stuck-state page lists it.
- **A card payment already taken can no longer read as unpaid again (#4081).**
  When Stripe confirmed a payment before the booking change or card step that
  asked for it had finished recording its request, that recording could set
  the payment back to "pending" and the booking would look as if it still owed
  the money. A recorded payment, or a refund made against it, now keeps its
  status. Nothing needs doing.
