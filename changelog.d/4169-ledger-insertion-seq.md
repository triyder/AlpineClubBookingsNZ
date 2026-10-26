- **Payment records saved at the same moment now always read in the same
  order** (#4132). When a booking change saves two payment records together -
  say a new payment request and the one it replaces - the system now always
  knows which came last. The payment summary, an edit that lowers the price,
  and the finance checks therefore agree on which request is the one still
  owed, and a refund split across charges saved together refunds the most
  recent one first. Records saved before this release are given an order on
  upgrade: anything cancelled, failed or withdrawn comes before what is still
  live, so the live request stays the one that counts. **Operators:** the
  upgrade briefly locks the payment records table - about 2 to 3.5 seconds per
  100,000 records - and has read-only pre-deploy checks (stored ties, and any
  unfinished card refund on them); see the migration's row in
  `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`.
