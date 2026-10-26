/**
 * #4291 (`INV-ADDPAY-041`): which payments a cancelled refund note still
 * recounts once its void has turned their mirror off. The real-PostgreSQL
 * suite (`xero-voided-note-recount.realdb.test.ts`) proves the reconcile end to
 * end; this pins the lookup's rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ linkFindMany: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { xeroObjectLink: { findMany: mocks.linkFindMany } },
}));

import { findPaymentIdsWithCancelledRefundNoteMirror } from "@/lib/xero-inbound/object-links";

describe("findPaymentIdsWithCancelledRefundNoteMirror (#4291)", () => {
  beforeEach(() => {
    mocks.linkFindMany.mockReset();
  });

  it("reads only the note's inactive payment refund-note mirrors", async () => {
    mocks.linkFindMany.mockResolvedValue([]);

    await expect(findPaymentIdsWithCancelledRefundNoteMirror("cn_1")).resolves.toEqual([]);

    expect(mocks.linkFindMany).toHaveBeenCalledWith({
      where: { localModel: "Payment", xeroObjectType: "CREDIT_NOTE", xeroObjectId: "cn_1", role: "REFUND_CREDIT_NOTE", active: false },
      select: { localId: true, metadata: true },
    });
  });

  it("MUTATION (recorded void): keeps a mirror recorded VOIDED or DELETED, never one retired while its note was live", async () => {
    mocks.linkFindMany.mockResolvedValue([
      { localId: "pay_voided", metadata: { status: "VOIDED" } },
      { localId: "pay_deleted", metadata: { status: " deleted " } },
      { localId: "pay_voided", metadata: { status: "VOIDED", amountCents: 500 } },
      { localId: "pay_superseded", metadata: { status: "AUTHORISED" } },
      { localId: "pay_unrecorded", metadata: { amountCents: 500 } },
      { localId: "pay_no_metadata", metadata: null },
    ]);

    await expect(findPaymentIdsWithCancelledRefundNoteMirror("cn_1")).resolves.toEqual(["pay_voided", "pay_deleted"]);
  });
});
