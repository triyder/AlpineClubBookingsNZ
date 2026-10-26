# File-size allowances for #4118 (issue #4116)

file: src/components/admin/booking-policies/minimum-night-stay-section.tsx
lines: 861
reason: the row Activate/Deactivate and Delete handlers live here and must
  capture and close the focus return around their own refresh, and each row's
  buttons name their row. The return itself is src/hooks/use-row-action-focus-return.ts
  and the keys and row headings are in list-row-focus.ts, both shared with
  booking periods, so what stays here is one call per open and close plus the
  markers on the rows.
