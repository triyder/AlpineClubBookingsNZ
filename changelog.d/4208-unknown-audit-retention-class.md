- **An audit entry with an unrecognised retention class is no longer kept
  forever (#3940).** The retention class is stored as plain text, so a value the
  app does not recognise matched no rule in the nightly prune and the entry was
  never deleted. Such an entry is now treated exactly like one with no class:
  deleted at its expiry date unless its severity is critical (seven years), with
  incident evidence keeping its ten-year floor and entries with no expiry date
  still kept. The first nightly run after the upgrade deletes, once and
  permanently (no archive copy), any such entries already past their date. The
  app's own writers only use the four known classes, so most clubs have none.
  `docs/UPGRADING.md` and `docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md` have a
  read-only query to count them on a copy first.
