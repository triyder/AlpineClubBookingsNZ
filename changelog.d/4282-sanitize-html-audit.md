- **Deeply nested HTML no longer breaks sanitization (#4281).** Upgrade
  sanitize-html to 2.18.1 to bound discarded iframe fallbacks and preserve the
  nesting limit. The existing braces patch, scope and expiry stay unchanged.
