- **A Xero retry is no longer marked failed by an earlier attempt that
  answers late (#4373).** When a Xero call stalled or failed and the operation
  was retried, the earlier attempt's late answer could still be written onto
  the retry while it was running, so the Xero Operations panel showed the
  retry as failed mid-run and a second retry could start beside it.

  Each attempt now records its outcome only on its own run. A late answer
  from an earlier attempt is left out and logged, and the retry's own result
  is the one shown. Nothing changes for operations that are not retried.
