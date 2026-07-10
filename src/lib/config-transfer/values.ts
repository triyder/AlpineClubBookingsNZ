import { strFromU8 } from "fflate";
import * as PrismaClientModule from "@prisma/client";

import { parseCsv, type CsvRow } from "./csv";

// Shared cell-value helpers for the config-transfer categories: one home for
// the CSV coercions that were previously copy-pasted per category, plus the
// STRICT validators behind the plan-time row-validation gate (invalid rows are
// errors that block apply — the bundle is fixed and re-previewed, the import
// never quietly writes less or different data than the file says).

/** Rows of a CSV file in the bundle, or [] when the file is absent. */
export function readCsvRows(
  files: Map<string, Uint8Array>,
  path: string,
): CsvRow[] {
  const bytes = files.get(path);
  return bytes ? parseCsv(strFromU8(bytes)).rows : [];
}

export function asStr(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}
export function nz(value: unknown): string | null {
  const s = asStr(value).trim();
  return s === "" ? null : s;
}
export function coerceBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  return asStr(value).trim().toLowerCase() === "true";
}

// ---- Strict validation ------------------------------------------------------
//
// Validators return { ok: true, value } or { ok: false, message }. Categories
// collect failures as plan ERRORS (not warnings): src/lib/config-transfer/import.ts
// blocks apply while any error exists, so nothing that would be rejected (or
// silently mangled) at write time survives the dry-run.

export type Valid<T> = { ok: true; value: T } | { ok: false; message: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Strict NZ date-only cell: must be YYYY-MM-DD and a real calendar date. */
export function strictDate(value: unknown): Valid<Date> {
  const s = asStr(value).trim();
  if (!DATE_ONLY.test(s)) {
    return { ok: false, message: `"${s}" is not a YYYY-MM-DD date` };
  }
  const date = new Date(`${s}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== s) {
    return { ok: false, message: `"${s}" is not a real calendar date` };
  }
  return { ok: true, value: date };
}

/** Strict boolean cell: exactly "true" or "false" (case-insensitive). */
export function strictBool(value: unknown): Valid<boolean> {
  const s = asStr(value).trim().toLowerCase();
  if (s === "true") return { ok: true, value: true };
  if (s === "false") return { ok: true, value: false };
  return { ok: false, message: `"${asStr(value)}" is not true/false` };
}

/** Strict integer cell (whole number, optional leading minus). */
export function strictInt(value: unknown): Valid<number> {
  const s = asStr(value).trim();
  if (!/^-?\d+$/.test(s)) {
    return { ok: false, message: `"${s}" is not a whole number` };
  }
  return { ok: true, value: Number.parseInt(s, 10) };
}

/**
 * Strict money cell: a non-negative integer number of cents. Never coerced —
 * a blank or malformed price must fail the dry-run, not write 0 cents
 * (docs/DOMAIN_INVARIANTS.md "money as integer cents").
 */
export function strictMoneyCents(value: unknown): Valid<number> {
  const s = asStr(value).trim();
  if (!/^\d+$/.test(s)) {
    return {
      ok: false,
      message: `"${s}" is not a non-negative whole number of cents`,
    };
  }
  return { ok: true, value: Number.parseInt(s, 10) };
}

const enumValuesCache = new Map<string, Set<string>>();

/**
 * The declared values of a Prisma schema enum, read from the generated
 * client's runtime enum objects (e.g. `SeasonType = { WINTER: "WINTER", … }`).
 * (Prisma 7's runtime DMMF ships an empty `datamodel.enums`, so the object
 * exports are the reliable source.)
 */
export function prismaEnumValues(enumName: string): Set<string> {
  let values = enumValuesCache.get(enumName);
  if (!values) {
    const exported = (PrismaClientModule as Record<string, unknown>)[enumName];
    if (!exported || typeof exported !== "object") {
      throw new Error(`Unknown Prisma enum: ${enumName}`);
    }
    values = new Set(Object.values(exported as Record<string, string>));
    enumValuesCache.set(enumName, values);
  }
  return values;
}

/** Strict enum cell, validated against the real Prisma enum's values. */
export function strictEnum(enumName: string, value: unknown): Valid<string> {
  const s = asStr(value).trim();
  const values = prismaEnumValues(enumName);
  if (!values.has(s)) {
    return {
      ok: false,
      message: `"${s}" is not a valid ${enumName} (expected one of: ${[...values].join(", ")})`,
    };
  }
  return { ok: true, value: s };
}

/** Strict optional enum: blank → null, otherwise must be a valid value. */
export function strictEnumOrNull(
  enumName: string,
  value: unknown,
): Valid<string | null> {
  if (asStr(value).trim() === "") return { ok: true, value: null };
  return strictEnum(enumName, value);
}

/**
 * Row-scoped validation collector: builds "file row N: field — message" error
 * strings and reports whether the row survived. Usage per row:
 *   const v = new RowValidator(file, index, errors);
 *   const start = v.date("startDate", raw.startDate);
 *   if (!v.ok) continue; // row excluded from plan items and apply
 */
export class RowValidator {
  ok = true;
  constructor(
    private readonly file: string,
    private readonly rowIndex: number,
    private readonly errors: string[],
  ) {}

  private fail(field: string, message: string): void {
    this.ok = false;
    // 1-based data row (header is row 1 in the file).
    this.errors.push(
      `${this.file} row ${this.rowIndex + 2}: ${field} — ${message}`,
    );
  }

  private check<T>(field: string, result: Valid<T>, fallback: T): T {
    if (result.ok) return result.value;
    this.fail(field, result.message);
    return fallback;
  }

  date(field: string, value: unknown): Date {
    return this.check(field, strictDate(value), new Date(0));
  }
  bool(field: string, value: unknown): boolean {
    return this.check(field, strictBool(value), false);
  }
  int(field: string, value: unknown): number {
    return this.check(field, strictInt(value), 0);
  }
  moneyCents(field: string, value: unknown): number {
    return this.check(field, strictMoneyCents(value), 0);
  }
  enum(field: string, enumName: string, value: unknown): string {
    return this.check(field, strictEnum(enumName, value), "");
  }
  enumOrNull(field: string, enumName: string, value: unknown): string | null {
    return this.check(field, strictEnumOrNull(enumName, value), null);
  }
  /** Non-empty string (e.g. a required name/key cell). */
  required(field: string, value: unknown): string {
    const s = asStr(value).trim();
    if (s === "") {
      this.fail(field, "must not be blank");
      return "";
    }
    return s;
  }
}
