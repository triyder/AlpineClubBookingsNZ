// Canonical Xero object-link cleanup: deactivates active canonical links whose
// local canonical field no longer points at them. Extracted verbatim from
// xero-hardening.ts (#1208 item 5). Import xero source modules directly, never
// the @/lib/xero facade (#1208).
import { prisma } from "@/lib/prisma";
import type {
  CanonicalLinkExpectation,
  CanonicalLinkRecord,
  XeroCanonicalLinkCleanupResult,
} from "./xero-hardening-types";
import { buildCanonicalScopeKey } from "./xero-hardening-shared";

function getCanonicalCleanupCategory(
  link: Pick<CanonicalLinkRecord, "localModel" | "role">
): keyof XeroCanonicalLinkCleanupResult["byCategory"] {
  if (link.localModel === "Member" && link.role === "CONTACT") {
    return "memberContacts";
  }
  if (link.localModel === "Payment" && link.role === "PRIMARY_INVOICE") {
    return "paymentInvoices";
  }
  if (link.localModel === "Payment" && link.role === "REFUND_CREDIT_NOTE") {
    return "paymentRefundCreditNotes";
  }
  if (link.localModel === "MemberSubscription" && link.role === "SUBSCRIPTION_INVOICE") {
    return "subscriptionInvoices";
  }
  return "otherCanonicalLinks";
}

export async function cleanupStaleCanonicalXeroObjectLinks(): Promise<XeroCanonicalLinkCleanupResult> {
  const [members, payments, subscriptions, links] = await Promise.all([
    prisma.member.findMany({
      where: {
        xeroContactId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroContactId: true,
      },
    }),
    prisma.payment.findMany({
      where: {
        OR: [
          {
            xeroInvoiceId: {
              not: null,
            },
          },
          {
            xeroRefundCreditNoteId: {
              not: null,
            },
          },
        ],
      },
      select: {
        id: true,
        xeroInvoiceId: true,
        xeroRefundCreditNoteId: true,
      },
    }),
    prisma.memberSubscription.findMany({
      where: {
        xeroInvoiceId: {
          not: null,
        },
      },
      select: {
        id: true,
        xeroInvoiceId: true,
      },
    }),
    prisma.xeroObjectLink.findMany({
      where: {
        active: true,
        OR: [
          {
            localModel: "Member",
            role: "CONTACT",
          },
          {
            localModel: "Payment",
            role: {
              in: ["PRIMARY_INVOICE", "REFUND_CREDIT_NOTE"],
            },
          },
          {
            localModel: "MemberSubscription",
            role: "SUBSCRIPTION_INVOICE",
          },
        ],
      },
      select: {
        id: true,
        localModel: true,
        localId: true,
        xeroObjectType: true,
        xeroObjectId: true,
        role: true,
      },
    }),
  ]);

  const expectations: CanonicalLinkExpectation[] = [
    ...members.flatMap((member) =>
      member.xeroContactId
        ? [
            {
              localModel: "Member",
              localId: member.id,
              role: "CONTACT",
              xeroObjectType: "CONTACT",
              xeroObjectId: member.xeroContactId,
            },
          ]
        : []
    ),
    ...payments.flatMap((payment) =>
      [
        payment.xeroInvoiceId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "PRIMARY_INVOICE",
              xeroObjectType: "INVOICE",
              xeroObjectId: payment.xeroInvoiceId,
            }
          : null,
        payment.xeroRefundCreditNoteId
          ? {
              localModel: "Payment",
              localId: payment.id,
              role: "REFUND_CREDIT_NOTE",
              xeroObjectType: "CREDIT_NOTE",
              xeroObjectId: payment.xeroRefundCreditNoteId,
            }
          : null,
      ].filter((value): value is CanonicalLinkExpectation => value !== null)
    ),
    ...subscriptions.flatMap((subscription) =>
      subscription.xeroInvoiceId
        ? [
            {
              localModel: "MemberSubscription",
              localId: subscription.id,
              role: "SUBSCRIPTION_INVOICE",
              xeroObjectType: "SUBSCRIPTION",
              xeroObjectId: subscription.xeroInvoiceId,
            },
          ]
        : []
    ),
  ];

  const expectationByScope = new Map(
    expectations.map((expectation) => [
      buildCanonicalScopeKey(expectation),
      expectation,
    ])
  );
  const staleLinks = links.filter((link) => {
    const expectation = expectationByScope.get(buildCanonicalScopeKey(link));
    if (!expectation) {
      return true;
    }

    return (
      expectation.xeroObjectType !== link.xeroObjectType ||
      expectation.xeroObjectId !== link.xeroObjectId
    );
  });
  const staleLinkIds = staleLinks.map((link) => link.id);

  let deactivatedLinks = 0;
  if (staleLinkIds.length > 0) {
    const updateResult = await prisma.xeroObjectLink.updateMany({
      where: {
        id: {
          in: staleLinkIds,
        },
        active: true,
      },
      data: {
        active: false,
      },
    });
    deactivatedLinks = updateResult.count;
  }

  const byCategory: XeroCanonicalLinkCleanupResult["byCategory"] = {
    memberContacts: 0,
    paymentInvoices: 0,
    paymentRefundCreditNotes: 0,
    subscriptionInvoices: 0,
    otherCanonicalLinks: 0,
  };

  for (const link of staleLinks) {
    byCategory[getCanonicalCleanupCategory(link)] += 1;
  }

  return {
    completedAt: new Date(),
    scannedActiveLinks: links.length,
    keptActiveLinks: links.length - deactivatedLinks,
    deactivatedLinks,
    byCategory,
    deactivatedLinkIds: staleLinkIds,
  };
}
