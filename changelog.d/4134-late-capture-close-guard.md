- **An approved late-card-charge refund no longer marks its retry record as
  done from under another process (#4126).** After a treasurer approves the
  refund of a late card charge, the app marked its retry record as done
  without checking whether the record had already moved on, for example
  because it was re-planned after a refusal, or picked up by the retry worker.
  It now marks it done only when the record is exactly as the approval left
  it. If the retry worker has picked it up, the worker finishes it and writes
  the refund record once, now naming the refund. If the record was left
  untouched and still could not be marked done, officers are alerted once,
  with the refund's id, to check it.
