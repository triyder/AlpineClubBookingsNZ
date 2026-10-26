# File-size allowance for #4235

file: src/lib/xero-sync.ts
lines: 1121
reason: the kept-void nonblocking Payment lock belongs beside the existing
  conditional pointer release, where both the original and normalized link
  statuses are available. Splitting that release for this short guard would
  separate its lock from the write it protects and broaden the concurrency fix.
