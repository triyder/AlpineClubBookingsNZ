import type { Prisma } from "@prisma/client";

// The closed set of audit retention classes. The column itself is free text, so
// the prune reads any other stored value as unclassified (#3940). The runbook's
// read-only queries (docs/AUDIT_RETENTION_ARCHIVE_RUNBOOK.md, "Rows with an
// unrecognised retention class") spell this list out; keep them in step.
export const AUDIT_RETENTION_CLASSES = [
  "critical",
  "sensitive_access",
  "diagnostic_high_volume",
  "standard",
] as const;

export type AuditRetentionClass = (typeof AUDIT_RETENTION_CLASSES)[number];

export function isAuditRetentionClass(value: unknown): value is AuditRetentionClass {
  return (AUDIT_RETENTION_CLASSES as readonly unknown[]).includes(value);
}

// #3940: a stored class outside the set matched no prune branch and was kept
// forever; it now reads as unclassified, like a NULL class (owner decision,
// 17 Oct 2026). `notIn` alone would miss NULL (SQL's NOT IN is unknown on
// NULL), so both arms are spelt out.
export const UNCLASSIFIED_RETENTION: Prisma.AuditLogWhereInput = {
  OR: [{ retentionClass: null }, { retentionClass: { notIn: [...AUDIT_RETENTION_CLASSES] } }],
};
