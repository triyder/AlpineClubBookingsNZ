import type { DataMigrationVerification } from "./types";

/**
 * #4132 (`INV-PAY-133`, owner decisions 15 Oct 2026: Option A, and "existing
 * tied rows are numbered with live rows last"): every `PaymentTransaction` row
 * gets an `insertionSeq` from an owned INTEGER sequence. The rows already
 * stored carry no record of the order they were inserted in, so the migration
 * numbers them by a RULE, under its own ACCESS EXCLUSIVE lock: `createdAt`;
 * within a tie, retired rows (FAILED, withdrawn, or a pending ask whose intent
 * is queued for cancellation) before live ones; then `ctid`. "The latest" of a
 * tie - the highest number - then lands on the live charge or ask.
 *
 * What an empty table cannot prove, and this fixture does:
 *
 * 1. THE RETIRED-FIRST RULE. A tie of five rows - one live ask later updated
 *    (which moves it later in the heap), a superseded ask with a cancellation
 *    queued, a withdrawn ask, a FAILED ask and a live capture - is numbered
 *    retired (superseded, withdrawn, failed) then live (capture, then the
 *    updated ask), each group in heap order.
 * 2. THE COORDINATOR'S MONEY CASE. A stored tie of a $10 superseded ask
 *    cancelled later (FAILED, written after the $30 live ask in the heap) and
 *    the $30 live ask: the $30 ask is the payment's latest ADDITIONAL row. By
 *    heap order alone the $10 one would be, and the mirror would show $10.
 * 3. HEAP ORDER BREAKS WHAT IS LEFT. Ten live rows on one payment, inserted with
 *    interleaved `createdAt` values (three ties), are numbered by `createdAt`
 *    and then insertion; ids are chosen so `id` order is the reverse.
 * 4. The next row written - an INSERT that omits the column, as a draining old
 *    colour's client does - is numbered above every stored row, and a fresh
 *    install's first row is numbered 1.
 */

const PARTIES = `
  INSERT INTO "Member" (
    "id", "email", "passwordHash", "firstName", "lastName", "updatedAt"
  ) VALUES (
    'dmv-4132-member', 'dmv-4132@example.invalid', 'x', 'Ledger', 'Order',
    timezone('UTC', statement_timestamp())
  );
  INSERT INTO "Booking" (
    "id", "memberId", "checkIn", "checkOut", "totalPriceCents", "finalPriceCents", "updatedAt"
  ) VALUES
    ('dmv-4132-booking-1', 'dmv-4132-member', DATE '2026-08-01', DATE '2026-08-03', 20000, 20000, timezone('UTC', statement_timestamp())),
    ('dmv-4132-booking-2', 'dmv-4132-member', DATE '2026-09-01', DATE '2026-09-03', 10000, 10000, timezone('UTC', statement_timestamp())),
    ('dmv-4132-booking-3', 'dmv-4132-member', DATE '2026-10-01', DATE '2026-10-03', 10000, 10000, timezone('UTC', statement_timestamp()));
  INSERT INTO "Payment" ("id", "bookingId", "amountCents", "updatedAt")
  VALUES
    ('dmv-4132-p1', 'dmv-4132-booking-1', 20000, timezone('UTC', statement_timestamp())),
    ('dmv-4132-p2', 'dmv-4132-booking-2', 10000, timezone('UTC', statement_timestamp())),
    ('dmv-4132-p3', 'dmv-4132-booking-3', 10000, timezone('UTC', statement_timestamp()));
`;

const TIE = `TIMESTAMP '2026-06-15 00:00:00'`;

/** A row the way a writer stores it: one statement per row, so heap order is insertion order. */
const row = (id: string, paymentId: string, kind: string, cents: number, status: string, createdAt: string, extra = "") => `
  INSERT INTO "PaymentTransaction" ("id", "paymentId", "kind", "stripePaymentIntentId", "amountCents", "status", "createdAt", "updatedAt"${extra ? `, "withdrawnAt"` : ""})
  VALUES ('${id}', '${paymentId}', '${kind}', 'pi_${id}', ${cents}, '${status}', ${createdAt}, ${createdAt}${extra ? `, ${extra}` : ""});
`;

const LEDGER = `
  ${PARTIES}
  -- 1. A five-row tie on p1, in insertion (heap) order.
  ${row("dmv-4132-p1-live-ask", "dmv-4132-p1", "ADDITIONAL", 1000, "PENDING", TIE)}
  ${row("dmv-4132-p1-superseded", "dmv-4132-p1", "ADDITIONAL", 2000, "PENDING", TIE)}
  ${row("dmv-4132-p1-withdrawn", "dmv-4132-p1", "ADDITIONAL", 3000, "FAILED", TIE, TIE)}
  ${row("dmv-4132-p1-failed", "dmv-4132-p1", "ADDITIONAL", 4000, "FAILED", TIE)}
  ${row("dmv-4132-p1-capture", "dmv-4132-p1", "PRIMARY", 20000, "SUCCEEDED", TIE)}
  -- The superseded ask's intent is queued for cancellation (its row is still PENDING).
  INSERT INTO "PaymentRecoveryOperation" ("id", "type", "bookingId", "paymentId", "paymentIntentId", "amountCents", "idempotencyKey", "updatedAt")
  VALUES ('dmv-4132-cancel', 'CANCEL_PAYMENT_INTENT', 'dmv-4132-booking-1', 'dmv-4132-p1', 'pi_dmv-4132-p1-superseded', 2000,
          'dmv-4132-cancel-key', timezone('UTC', statement_timestamp()));
  -- The live ask moves on (an indexed column): its new tuple goes later in the heap.
  UPDATE "PaymentTransaction" SET "status" = 'PROCESSING' WHERE "id" = 'dmv-4132-p1-live-ask';

  -- 2. p2: a $10 ask and the $30 ask that superseded it, written together; the $10
  -- one is cancelled later, so its FAILED tuple sits after the $30 one in the heap.
  ${row("dmv-4132-p2-ten", "dmv-4132-p2", "ADDITIONAL", 1000, "PENDING", TIE)}
  ${row("dmv-4132-p2-thirty", "dmv-4132-p2", "ADDITIONAL", 3000, "PENDING", TIE)}
  UPDATE "PaymentTransaction" SET "status" = 'FAILED' WHERE "id" = 'dmv-4132-p2-ten';

  -- 3. p3: ten live rows, createdAt interleaved (ties at t1, t2, t3), ids
  -- descending so id order is the reverse of insertion order.
  ${row("dmv-4132-p3-j", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-03 00:00:00'")}
  ${row("dmv-4132-p3-i", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-01 00:00:00'")}
  ${row("dmv-4132-p3-h", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-02 00:00:00'")}
  ${row("dmv-4132-p3-g", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-01 00:00:00'")}
  ${row("dmv-4132-p3-f", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-03 00:00:00'")}
  ${row("dmv-4132-p3-e", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-02 00:00:00'")}
  ${row("dmv-4132-p3-d", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-01 00:00:00'")}
  ${row("dmv-4132-p3-c", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-03 00:00:00'")}
  ${row("dmv-4132-p3-b", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-02 00:00:00'")}
  ${row("dmv-4132-p3-a", "dmv-4132-p3", "ADDITIONAL", 100, "SUCCEEDED", "TIMESTAMP '2026-06-01 00:00:00'")}
`;

/**
 * One payment's stored rows by their number alone. Stored rows are numbered
 * createdAt first, so this is also the order a reader meets them in from now
 * on - and a numbering that broke the createdAt order shows here too.
 */
const NUMBERED = (paymentId: string) => `
  SELECT "id"
  FROM "PaymentTransaction"
  WHERE "paymentId" = '${paymentId}' AND "id" <> 'dmv-4132-old-client'
  ORDER BY "insertionSeq"
`;

const ids = (...list: string[]) => list.map((id) => ({ id }));

/** p2's latest ADDITIONAL row, as `latestTransactionOfKind` picks it: both rows tie, so the higher number. */
const LATEST_ASK = `
  SELECT "id", "amountCents"
  FROM "PaymentTransaction"
  WHERE "paymentId" = 'dmv-4132-p2' AND "kind" = 'ADDITIONAL'
  ORDER BY "insertionSeq" DESC
  LIMIT 1
`;

const COLUMN_DEFINITION = `
  SELECT "data_type" AS "dataType", "is_nullable" AS "isNullable", "column_default" AS "columnDefault",
         pg_get_serial_sequence('"PaymentTransaction"', 'insertionSeq') AS "ownedSequence"
  FROM information_schema.columns
  WHERE "table_schema" = current_schema()
    AND "table_name" = 'PaymentTransaction'
    AND "column_name" = 'insertionSeq'
`;

const COLUMN_AFTER = {
  dataType: "integer",
  isNullable: "NO",
  columnDefault: `nextval('"PaymentTransaction_insertionSeq_seq"'::regclass)`,
  ownedSequence: `public."PaymentTransaction_insertionSeq_seq"`,
};

/** A write that names no insertionSeq, as a draining old colour's client makes. */
const OLD_CLIENT_INSERT = `
  INSERT INTO "PaymentTransaction" ("id", "paymentId", "kind", "amountCents", "createdAt", "updatedAt")
  VALUES ('dmv-4132-old-client', 'dmv-4132-p1', 'ADDITIONAL', 500, ${TIE}, ${TIE});
`;

/** Is the old client's row numbered above every other row? */
const OLD_CLIENT_ABOVE_ALL = `
  SELECT ("insertionSeq" > (SELECT max("insertionSeq") FROM "PaymentTransaction" WHERE "id" <> 'dmv-4132-old-client')) AS "aboveAll",
         "insertionSeq" = (SELECT count(*) FROM "PaymentTransaction") AS "nextAfterCount"
  FROM "PaymentTransaction" WHERE "id" = 'dmv-4132-old-client'
`;

const OLD_CLIENT_ROW = `
  SELECT "insertionSeq" FROM "PaymentTransaction" WHERE "id" = 'dmv-4132-old-client'
`;

const verification: DataMigrationVerification = {
  migration: "20261117010000_add_payment_transaction_insertion_seq",
  intent:
    "Add PaymentTransaction.insertionSeq, NOT NULL, defaulted from an owned INTEGER sequence; number every stored row by createdAt, then retired rows (FAILED, withdrawn, or an ask whose intent is queued for cancellation) before live ones within a tie, then heap order; and set the sequence so the next row is numbered above every stored row.",
  // The migration carries an explicit BEGIN/COMMIT envelope: this mode.
  executionMode: "isolated_database",
  idempotentReRun: false,
  cases: [
    {
      name: "a club whose ledger holds ties of retired and live rows, an updated row, and interleaved createdAt values",
      seed: LEDGER,
      afterMigration: OLD_CLIENT_INSERT,
      expectations: [
        {
          claim:
            "a tie is numbered retired first (superseded, withdrawn, failed, in heap order), then live (the capture, then the ask updated later)",
          sql: NUMBERED("dmv-4132-p1"),
          rows: ids(
            "dmv-4132-p1-superseded",
            "dmv-4132-p1-withdrawn",
            "dmv-4132-p1-failed",
            "dmv-4132-p1-capture",
            "dmv-4132-p1-live-ask",
          ),
        },
        {
          claim: "a stored tie of a $10 superseded ask cancelled later and the $30 live ask: the latest ask is the $30 one",
          sql: LATEST_ASK,
          rows: [{ id: "dmv-4132-p2-thirty", amountCents: 3000 }],
        },
        {
          claim: "live rows are numbered by createdAt, then the order they were inserted in - never by id",
          sql: NUMBERED("dmv-4132-p3"),
          rows: ids(
            "dmv-4132-p3-i",
            "dmv-4132-p3-g",
            "dmv-4132-p3-d",
            "dmv-4132-p3-a",
            "dmv-4132-p3-h",
            "dmv-4132-p3-e",
            "dmv-4132-p3-b",
            "dmv-4132-p3-j",
            "dmv-4132-p3-f",
            "dmv-4132-p3-c",
          ),
        },
        {
          claim: "an INSERT that omits insertionSeq is numbered above every stored row, as the next number",
          sql: OLD_CLIENT_ABOVE_ALL,
          rows: [{ aboveAll: true, nextAfterCount: true }],
        },
        {
          claim: "the column is an INTEGER, NOT NULL, defaulted from the sequence it owns",
          sql: COLUMN_DEFINITION,
          rows: [COLUMN_AFTER],
        },
      ],
    },
    {
      name: "a fresh install with no ledger rows",
      seed: PARTIES,
      afterMigration: OLD_CLIENT_INSERT,
      expectations: [
        {
          claim: "the first row written is numbered 1",
          sql: OLD_CLIENT_ROW,
          rows: [{ insertionSeq: 1 }],
        },
        {
          claim: "the column is an INTEGER, NOT NULL, defaulted from the sequence it owns",
          sql: COLUMN_DEFINITION,
          rows: [COLUMN_AFTER],
        },
      ],
    },
  ],
  mutants: [
    {
      name: "number a tie by heap order alone, without the retired-first rule",
      harm:
        "A stored tie whose superseded ask was cancelled after the live one is numbered with the cancelled ask last, so 'the latest ask' - the Payment mirror, the ask a reduction sets against - becomes the dead $10 ask instead of the live $30 one.",
      find: `      CASE
        WHEN t."status" = 'FAILED' OR t."withdrawnAt" IS NOT NULL THEN 0
        WHEN t."status" IN ('PENDING', 'PROCESSING') AND EXISTS (
          SELECT 1 FROM "PaymentRecoveryOperation" AS "cancel"
          WHERE "cancel"."type" = 'CANCEL_PAYMENT_INTENT'
            AND ("cancel"."paymentTransactionId" = t."id" OR "cancel"."paymentIntentId" = t."stripePaymentIntentId")
        ) THEN 0
        ELSE 1
      END,
`,
      replace: "",
    },
    {
      name: "put live rows first and retired rows last",
      harm: "Every stored tie's latest row is a retired one, so the mirror and the reduction read a dead ask as live.",
      find: `        ELSE 1\n`,
      replace: `        ELSE -1\n`,
    },
    {
      name: "treat a pending ask queued for cancellation as live",
      harm:
        "A superseded ask whose cancellation has not landed yet is numbered among the live rows, and can be read as the latest ask.",
      find: `        ) THEN 0\n`,
      replace: `        ) THEN 1\n`,
    },
    {
      name: "drop ctid, leaving what is left of a tie to the sort",
      harm:
        "Rows with the same createdAt and class are numbered in whatever order the sort happens to leave them, so the release can reorder a stored tie arbitrarily.",
      find: `      END,\n      t.ctid\n`,
      replace: `      END\n`,
    },
    {
      name: "break what is left of a tie by id instead of heap order",
      harm:
        "A tie is numbered in cuid order, which does not follow insertion - the #4129 failure, made permanent.",
      find: `      t.ctid\n`,
      replace: `      t."id"\n`,
    },
    {
      name: "number newest first",
      harm: "Every stored row is reversed, so the oldest-first fold and the newest-first refund slices swap rows.",
      find: `    ORDER BY t."createdAt",\n`,
      replace: `    ORDER BY t."createdAt" DESC,\n`,
    },
    {
      name: "start the sequence at the highest stored number, not above it",
      harm:
        "The first row written after the release shares a number with the newest stored row, so a tie between them has no order again.",
      find: `COALESCE((SELECT max("insertionSeq") FROM "PaymentTransaction"), 0) + 1, false)`,
      replace: `COALESCE((SELECT max("insertionSeq") FROM "PaymentTransaction"), 1), false)`,
    },
  ],
};

export default verification;
