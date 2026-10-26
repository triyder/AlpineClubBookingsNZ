# File-size allowances for #4190

file: src/app/api/admin/members/export/route.ts
lines: 546
reason: The only net growth is one import of the canonical literal-search helper.
  Splitting this existing module would add an unrelated refactor to the bounded
  search-filter fix; the existing query structure and behavior stay together.

file: src/app/api/admin/page-content/route.ts
lines: 911
reason: The only net growth is one import of the canonical literal-search helper.
  Splitting this existing module would add an unrelated refactor to the bounded
  search-filter fix; the existing query structure and behavior stay together.

file: src/lib/admin-bookings-service.ts
lines: 1440
reason: The only net growth is one import of the canonical literal-search helper.
  Splitting this existing module would add an unrelated refactor to the bounded
  search-filter fix; the existing query structure and behavior stay together.

file: src/lib/admin-family-group-requests-service.ts
lines: 1710
reason: The only net growth is one import of the canonical literal-search helper.
  Splitting this existing module would add an unrelated refactor to the bounded
  search-filter fix; the existing query structure and behavior stay together.

file: src/lib/member-application-mapping.ts
lines: 1180
reason: The only net growth is one import of the canonical literal-search helper.
  Splitting this existing module would add an unrelated refactor to the bounded
  search-filter fix; the existing query structure and behavior stay together.
