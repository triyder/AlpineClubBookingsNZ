- **The payments job's check on group organiser card refunds can no longer
  hang on a slow card provider (#4130).** Each check now gives up after ten
  seconds without retrying, and the pass starts no new check after a minute, as the
  card-refund check that runs after it already does. The refunds checked least
  recently go first, so the ones it skips, that keep timing out, or that
  cannot be saved, are checked on later runs without holding up the rest.
