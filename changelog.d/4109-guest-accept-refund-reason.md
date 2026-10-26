- **A card refund that follows a guest's acceptance lowering a booking's price
  now recovers if the first attempt is interrupted (#4101).** When a guest
  accepting their place re-prices a paid booking down, the club refunds the
  difference to the card. If that refund was interrupted after the card
  provider had already made it (a timeout, for example), the background retry
  sent a slightly different request under the same reference, the provider
  refused it, and the retry never finished, leaving an officer to reconcile by
  hand a refund that had in fact been made. The retry now sends exactly the
  original request, so it picks up the refund already made and records it. This
  never refunds a member twice. The other refund retries were checked and
  already matched their original requests.

  For operators: a retry that had already given up before this release stays
  stuck. Stripe did make that refund, so check the Stripe dashboard and do not
  pay the member again. The **Card refunds Stripe gave up on** list now marks
  such a row **Stripe may have refunded**.
