- **A Xero task that two parts of the app run at once no longer shows as failed
  when one of them succeeded (#4356).** The app keeps at most one live Xero
  task per document, so when two parts of the app start the same task at once
  they share it and each sends the same request to Xero. If one succeeded and
  the other was turned away (for example by Xero's rate limit, or because the
  same request was already being handled), whichever answer came back last was
  recorded. A task whose payment, invoice or credit note was in Xero could
  therefore show as failed on the Xero Operations page and count towards the
  repeated-failure alert. A failure is now never recorded over a success or a
  part-success, and a part-success is never recorded over a full success; a
  success still replaces an earlier failure, because it is Xero's answer to the
  same request. A late failure also no longer lands on a part-completed task
  while Retry is repairing it, which could leave the payment unrecorded.
  Nothing changes in Xero, and no money moves.
