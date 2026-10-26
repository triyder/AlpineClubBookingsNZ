- **An audit entry kept as evidence of an incident is now kept for 10 years
  instead of being deleted when its retention period runs out (#3939).** The
  nightly retention job already kept the IP address and browser details of an
  entry marked as preserved for an incident, but it still deleted the entry
  itself at its expiry date, which defeated the point of preserving it. A
  preserved entry now skips its normal expiry and is deleted 10 years after it
  was recorded, from the audit log and from the audit archive alike, or later if
  its normal retention is longer: preservation never shortens it. Today these
  are the entries for an admin capacity hold or force-confirm that overbooked
  the lodge.

  Nothing is deleted on the first run after the upgrade because of this change:
  the preservation flag dates from May 2026, so no preserved entry can reach 10
  years before 2036. There is no in-app control to release a preserved entry
  early, and the Audit Log screen does not mark which entries are preserved; the
  audit retention and archive runbook has a read-only query to count them in
  the audit log and in the archive.
