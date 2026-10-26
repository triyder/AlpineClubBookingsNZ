- **The retry of a lost card request for a price increase now looks for the
  earlier request more narrowly (#4079).** When a paid booking's price goes up
  and Stripe refuses the automatic retry of the card request, the retry looks
  for the request Stripe already made. It used to also accept one labelled the
  way the previous version of the retry labelled its own requests; no such retry
  is left, so it no longer does, and it only looks at requests made around the
  time the original one failed. On a very busy Stripe account the search no
  longer gives up just because of the number of later card requests. In the rare
  case where the earlier request can't be found, the retry now gives up and
  alerts an administrator instead of reusing a request it can't be sure is this
  one; the administrator checks Stripe for that booking and amount. Upgrading
  from v0.13.2 or earlier: run a release containing #4077 for a day first, or
  any leftover retry from the old version ends the same way.
