- **The starter privacy policy states the real audit-log retention schedule
  (#4031).** Section 7 said system audit logs are deleted after 90 days. It now
  lists the schedule kind by kind: diagnostic entries 90 days, sensitive-access
  records 2 years (up to 7 with an audit archive), change, security and routine
  system records 7 years, and incident evidence at least 10 years, with IP
  address and browser details removed after 90 days. The privacy page's "Last
  updated" date moves to 17 October 2026.

  New clubs get the corrected text. A club whose privacy page still has the
  exact starter text is updated automatically on upgrade, and its header date
  moves only if the header is also the starter one. **If your club has edited
  its privacy policy text, review your section 7**; a page whose text was
  edited is not changed.
  `docs/UPGRADING.md` has the post-upgrade check.
