- **The audit log's category filters now match action names exactly (#4165).**
  For older activity entries recorded without a category, the Admin Audit Log
  and a member's own activity timeline decide the category from the action's
  name. Those name checks treated `_` as "any character" (in the starts-with
  checks and in the one contains check that has one, `DATA_EXPORT`), so the Xero
  filter's `xero_` check also picked up every `xero.` entry, such as a Xero operation
  marked failed or a contact synced to a member. The checks now match the name
  exactly, and the `xero.` entries are named on the Xero filter on purpose, so
  nothing moves: every action the platform writes, and every action in the
  recorded history of uncategorised entries, stays under the same category and
  on the same member timelines as before. A real-PostgreSQL test pins that.
