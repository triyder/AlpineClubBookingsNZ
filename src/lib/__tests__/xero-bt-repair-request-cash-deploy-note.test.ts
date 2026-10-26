import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PaymentSource } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE,
  REFUND_REQUEST_HAND_BACK_KEY_PREFIX,
} from "@/lib/manual-refund-task-settlement-rules";
import { refundRequestCreditNoteKey } from "@/lib/xero-credit-notes";
import { readRefundRequestIdFromPayload, REFUND_REQUEST_CREDIT_NOTE_ROLE } from "@/lib/refund-request-credit-note";
import { XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE } from "@/lib/xero-operation-outbox-payload";
import { REFUND_CREDIT_NOTE_LINK_WHERE } from "@/lib/xero-refund-note-status";

/**
 * #4231 (`INV-SSOT`, lens F3): the #4215 deploy note's read-only SQL spells a
 * refund request's paid-back hand-back - kind, status, key prefix - and a
 * request note's key by hand, because an operator runs it in psql. This pins
 * every such literal in that note to the code's one definition, so a drift in
 * either fails here rather than leaving an operator with a query that quietly
 * lists nothing.
 */
const REPO_ROOT = resolve(__dirname, "../../..");

function deployNote(): string {
  const doc = readFileSync(resolve(REPO_ROOT, "docs/xero/ARCHITECTURE.md"), "utf8");
  const start = doc.indexOf("**Deploy and rollback note (#4215).**");
  const end = doc.indexOf("**Re-raising a voided request note is the officer's decision (#4214", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]);

describe("the #4215 deploy note's SQL matches the code's one definition (#4231)", () => {
  const note = deployNote();
  const where = COMPLETED_REFUND_REQUEST_HAND_BACK_TASK_WHERE;

  it("spells the hand-back's kind, status and key prefix as the where fragment does", () => {
    const kinds = all(note, /m\.kind = '([^']*)'/g);
    const statuses = all(note, /m\.status = '([^']*)'/g);
    const prefixes = all(note, /starts_with\(m\."occurrenceKey", '([^']*)'\)/g);
    // Both checks name the hand-back twice: in the request-cash column and in the filter.
    expect(kinds.length).toBeGreaterThanOrEqual(4);
    expect(new Set(kinds)).toEqual(new Set([where.kind]));
    expect(statuses.length).toBe(kinds.length);
    expect(new Set(statuses)).toEqual(new Set([where.status]));
    expect(prefixes.length).toBe(kinds.length);
    expect(new Set(prefixes)).toEqual(new Set([where.occurrenceKey.startsWith, REFUND_REQUEST_HAND_BACK_KEY_PREFIX]));
  });

  it("cuts the request id off the occurrence key at the prefix's length", () => {
    const offsets = all(note, /substr\(m\."occurrenceKey", (\d+)\)/g);
    expect(offsets.length).toBeGreaterThan(0);
    // SQL's substr is 1-based: the id starts one past the prefix.
    expect(new Set(offsets)).toEqual(new Set([String(REFUND_REQUEST_HAND_BACK_KEY_PREFIX.length + 1)]));
  });

  it("builds a request note's key prefix as `refundRequestCreditNoteKey` does, everywhere it is built", () => {
    const built = [...note.matchAll(/'([^']*)' \|\| p\.id \|\| '([^']*)' \|\| substr\(m\."occurrenceKey", \d+\) \|\| '([^']*)'/g)];
    expect(built.length).toBeGreaterThanOrEqual(3);
    for (const [, head, middle, tail] of built) {
      expect(refundRequestCreditNoteKey("PAYMENT", "REQUEST").startsWith(`${head}PAYMENT${middle}REQUEST${tail}`)).toBe(true);
    }
    // A cancellation note's create row is told from a request's by the same key segment.
    for (const segment of all(note, /position\('([^']*)' in /g)) {
      expect(refundRequestCreditNoteKey("PAYMENT", "REQUEST")).toContain(segment);
      expect(segment).toBe(`:${refundRequestCreditNoteKey("P", "R").split(":")[2]}:`);
    }
  });

  it("reads a request's id from a row's payload and a link's metadata by the field the code reads", () => {
    const fields = all(note, /(?:"requestPayload"|metadata)->>'([^']*)'/g).filter((field) => field !== "queueType");
    expect(fields.length).toBeGreaterThanOrEqual(4);
    for (const field of fields) expect(readRefundRequestIdFromPayload({ [field]: "REQUEST" })).toBe("REQUEST");
  });

  it("names the payment source, the note roles, the queue type and the row shapes the code uses", () => {
    const arm = readFileSync(resolve(REPO_ROOT, "src/lib/xero-booking-repair-request-notes.ts"), "utf8");
    expect(new Set(all(note, /p\.source = '([^']*)'/g))).toEqual(new Set([PaymentSource.INTERNET_BANKING]));
    // The request note's role is the code's constant; the payment's own refund note's is the role the arm reads.
    const roles = new Set([...all(note, /\.role = '([^']*)'/g), ...all(note, /\.role IN \(([^)]*)\)/g).flatMap((list) => list.split(", ").map((item) => item.slice(1, -1)))]);
    for (const role of roles) {
      if (role === REFUND_REQUEST_CREDIT_NOTE_ROLE) continue;
      expect(["REFUND_CREDIT_NOTE", "ACCOUNT_CREDIT_NOTE"]).toContain(role);
    }
    expect(roles).toContain(REFUND_REQUEST_CREDIT_NOTE_ROLE);
    // Lens round 5 (F5): the cancellation note's link, as the tool reads it, is the one exported filter.
    const cancellationLinks = [...note.matchAll(/FROM "XeroObjectLink" c WHERE c\."localModel" = '([^']*)' AND c\."localId" = p\.id AND c\."xeroObjectType" = '([^']*)' AND c\.role = '([^']*)'\)/g)];
    expect(cancellationLinks.length).toBeGreaterThan(0);
    for (const [, localModel, xeroObjectType, role] of cancellationLinks) {
      expect({ localModel, xeroObjectType, role }).toEqual(REFUND_CREDIT_NOTE_LINK_WHERE);
    }
    // The value compared, and the one a legacy row naming no queue type is read as (the arm counts it).
    const queueTypes = [...note.matchAll(/->>'queueType'(?:, '([^']*)')?\) = '([^']*)'/g)].flatMap((match) => [match[1], match[2]].filter(Boolean) as string[]);
    expect(queueTypes.length).toBeGreaterThan(0);
    expect(new Set(queueTypes)).toEqual(new Set([XERO_OUTBOX_REFUND_CREDIT_NOTE_TYPE]));
    for (const entityType of all(note, /"entityType" = '([^']*)'/g)) {
      expect(entityType).toBe("CREDIT_NOTE");
      expect(arm).toContain(`operation.entityType === "${entityType}"`);
    }
    for (const operationType of all(note, /"operationType" = '([^']*)'/g)) {
      expect(operationType).toBe("CREATE");
      expect(arm).toContain(`operation.operationType === "${operationType}"`);
    }
    for (const objectType of all(note, /"xeroObjectType" = '([^']*)'/g)) {
      expect(objectType).toBe(REFUND_CREDIT_NOTE_LINK_WHERE.xeroObjectType);
    }
  });
});
