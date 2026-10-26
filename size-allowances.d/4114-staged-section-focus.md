# File-size allowances for #4114 (issue #4087)

file: src/components/admin/booking-policies/minimum-night-stay-section.tsx
lines: 850
reason: the list owns the focus return for its per-row editor, because that
  editor unmounts on close and cannot return focus itself. Eight lines wire the
  shared useEditorFocusReturn helper into the open, cancel, save and conflict
  paths that already live here; moving them out would split one editor
  lifecycle across two files.
