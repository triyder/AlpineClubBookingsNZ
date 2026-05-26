/**
 * Xero contact create/update/search and stale-link repair.
 *
 * Provides `findOrCreateXeroContact`, `createXeroContactForMember`,
 * `updateXeroContact`, the contact-name normalisation helpers used for
 * matching, and the `retryXeroWriteWithContactRepair` helper that
 * invoice write paths call when Xero reports a stale contact link.
 * Duplicate-detection and potential-match helpers live in
 * xero-duplicate-contacts.ts.
 */

import {
  Address,
  Contact,
  Phone,
  type XeroClient,
} from "xero-node";
import { prisma } from "./prisma";
import logger from "@/lib/logger";
import { buildXeroContactUrl } from "@/lib/xero-links";
import {
  buildXeroIdempotencyKey,
  buildXeroPayloadHash,
  completeXeroSyncOperation,
  failXeroSyncOperation,
  sanitizeForJson,
  startXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";
import type { Prisma } from "@prisma/client";
import {
  callXeroApi,
  getAuthenticatedXeroClient,
  getXeroErrorSearchText,
  isRetryableXeroContactReferenceError,
  XeroDailyLimitError,
} from "./xero-api-client";
import { syncManagedXeroContactGroupForMember } from "./xero-contact-groups";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export class XeroContactValidationError extends Error {
  missingFields: string[];

  constructor(missingFields: string[]) {
    super(
      `Member is missing required fields for Xero contact creation: ${missingFields.join(", ")}`
    );
    this.name = "XeroContactValidationError";
    this.missingFields = missingFields;
  }
}

export interface FindOrCreateXeroContactOptions {
  createdByMemberId?: string;
  repairExistingLink?: boolean;
}

export interface XeroContactUpdateData {
  firstName?: string;
  lastName?: string;
  email: string;
  dateOfBirth?: Date | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
}

// ---------------------------------------------------------------------------
// Normalisation / matching helpers
// ---------------------------------------------------------------------------

export function normalizeXeroContactMatchValue(
  value: string | null | undefined
): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  );
}

export function buildMemberFullName(member: {
  firstName: string | null;
  lastName: string | null;
}): string {
  return [member.firstName, member.lastName]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildXeroContactDisplayName(
  contact: Pick<Contact, "name" | "firstName" | "lastName">
) {
  if (contact.name?.trim()) {
    return contact.name.trim();
  }

  return [contact.firstName, contact.lastName]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeXeroContactMatchValue(
  value: string | null | undefined
): string[] {
  return normalizeXeroContactMatchValue(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function namesLookSimilarForPotentialMatch(
  memberName: string,
  contactName: string
): boolean {
  const memberTokens = [...new Set(tokenizeXeroContactMatchValue(memberName))];
  const contactTokens = new Set(tokenizeXeroContactMatchValue(contactName));

  if (memberTokens.length === 0 || contactTokens.size === 0) {
    return false;
  }

  let matchedTokens = 0;
  for (const token of memberTokens) {
    if (contactTokens.has(token)) {
      matchedTokens += 1;
    }
  }

  const requiredMatches = Math.min(memberTokens.length, 2);
  return matchedTokens >= requiredMatches;
}

export function isDuplicateActiveXeroContactNameError(error: unknown): boolean {
  const text = getXeroErrorSearchText(error);
  return (
    text.includes("already assigned to another contact") ||
    (text.includes("contact name") && text.includes("must be unique"))
  );
}

export function parseXeroCompanyNumberDate(
  companyNumber?: string | null
): Date | null {
  if (!companyNumber) {
    return null;
  }

  const match = companyNumber.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, dd, mm, yyyy] = match;
  const parsed = new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Address builders / validation
// ---------------------------------------------------------------------------

export function buildXeroAddresses(member: {
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
}): Address[] {
  const addresses: Address[] = [];
  if (member.streetAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.STREET,
      addressLine1: member.streetAddressLine1,
      addressLine2: member.streetAddressLine2 || "",
      city: member.streetCity || "",
      region: member.streetRegion || "",
      postalCode: member.streetPostalCode || "",
      country: member.streetCountry || "",
    });
  }
  if (member.postalAddressLine1) {
    addresses.push({
      addressType: Address.AddressTypeEnum.POBOX,
      addressLine1: member.postalAddressLine1,
      addressLine2: member.postalAddressLine2 || "",
      city: member.postalCity || "",
      region: member.postalRegion || "",
      postalCode: member.postalPostalCode || "",
      country: member.postalCountry || "",
    });
  }
  return addresses;
}

export function getMissingFieldsForXeroContactCreate(member: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  streetAddressLine1?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
  dateOfBirth?: Date | null;
  joinedDate?: Date | null;
}): string[] {
  const missingFields: string[] = [];

  if (!member.firstName?.trim()) missingFields.push("First Name");
  if (!member.lastName?.trim()) missingFields.push("Last Name");
  if (!member.email?.trim()) missingFields.push("Email");
  if (
    !member.phoneCountryCode?.trim() ||
    !member.phoneAreaCode?.trim() ||
    !member.phoneNumber?.trim()
  ) {
    missingFields.push("Phone");
  }
  if (!member.dateOfBirth) missingFields.push("Date of Birth");
  if (!member.joinedDate) missingFields.push("Joined Date");
  if (
    !member.streetAddressLine1?.trim() ||
    !member.streetCity?.trim() ||
    !member.streetRegion?.trim() ||
    !member.streetPostalCode?.trim() ||
    !member.streetCountry?.trim()
  ) {
    missingFields.push("Physical Address");
  }
  if (
    !member.postalAddressLine1?.trim() ||
    !member.postalCity?.trim() ||
    !member.postalRegion?.trim() ||
    !member.postalPostalCode?.trim() ||
    !member.postalCountry?.trim()
  ) {
    missingFields.push("Postal Address");
  }

  return missingFields;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function linkMatchedXeroContact(
  tx: Prisma.TransactionClient,
  input: {
    memberId: string;
    contactId: string;
    previousXeroContactId?: string | null;
    repairExistingLink?: boolean;
    linkedVia:
      | "email_match"
      | "email_match_repair"
      | "name_match"
      | "name_match_repair";
    contactName?: string | null;
  }
) {
  const existingLink = await tx.member.findFirst({
    where: {
      xeroContactId: input.contactId,
      id: { not: input.memberId },
    },
    select: {
      firstName: true,
      lastName: true,
    },
  });

  if (existingLink) {
    throw new Error(
      `Matched Xero contact is already linked to ${existingLink.firstName} ${existingLink.lastName}.`
    );
  }

  await tx.member.update({
    where: { id: input.memberId },
    data: { xeroContactId: input.contactId },
  });
  await upsertXeroObjectLink({
    localModel: "Member",
    localId: input.memberId,
    xeroObjectType: "CONTACT",
    xeroObjectId: input.contactId,
    xeroObjectUrl: buildXeroContactUrl(input.contactId),
    role: "CONTACT",
    metadata: {
      linkedVia: input.linkedVia,
      contactName: input.contactName?.trim() ? input.contactName.trim() : undefined,
      repairedFromXeroContactId:
        input.repairExistingLink &&
        input.previousXeroContactId &&
        input.previousXeroContactId !== input.contactId
          ? input.previousXeroContactId
          : undefined,
    },
  });
}

export async function findExistingXeroContactByExactName(input: {
  xero: XeroClient;
  tenantId: string;
  fullName: string;
  contextPrefix: string;
}): Promise<Contact | null> {
  const normalizedName = normalizeXeroContactMatchValue(input.fullName);
  if (!normalizedName) {
    return null;
  }

  const contactsResponse = await callXeroApi(
    () =>
      input.xero.accountingApi.getContacts(
        input.tenantId,
        undefined, // ifModifiedSince
        undefined, // where
        undefined, // order
        undefined, // iDs
        1, // page
        false, // includeArchived
        true, // summaryOnly
        input.fullName.replace(/"/g, ""),
        20 // pageSize
      ),
    {
      operation: "getContacts",
      resourceType: "CONTACT",
      workflow: "findOrCreateXeroContact",
      context: `${input.contextPrefix} searchByName(${input.fullName})`,
    }
  );

  return (
    contactsResponse.body.contacts?.find(
      (contact) =>
        normalizeXeroContactMatchValue(buildXeroContactDisplayName(contact)) ===
        normalizedName
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Find / create
// ---------------------------------------------------------------------------

export async function findOrCreateXeroContact(
  memberId: string,
  options?: FindOrCreateXeroContactOptions
): Promise<string> {
  const xeroContactId = await prisma.$transaction(async (tx) => {
    // Advisory lock prevents concurrent duplicate creation for same member
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;

    const member = await tx.member.findUnique({
      where: { id: memberId },
    });
    if (!member) throw new Error(`Member not found: ${memberId}`);

    // Trust the persisted contact link on steady-state write paths and avoid
    // a read-before-write. Retry/repair paths can opt in to relinking.
    if (member.xeroContactId && !options?.repairExistingLink) {
      await upsertXeroObjectLink({
        localModel: "Member",
        localId: memberId,
        xeroObjectType: "CONTACT",
        xeroObjectId: member.xeroContactId,
        xeroObjectUrl: buildXeroContactUrl(member.xeroContactId),
        role: "CONTACT",
      });
      return member.xeroContactId;
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();
    const previousXeroContactId = member.xeroContactId;

    // Search by email first.
    // Email quotes are stripped to keep the OData filter syntactically valid;
    // z.string().email() at the API boundary ensures only RFC-valid emails
    // reach this point, so no further escaping is needed.
    try {
      const contactsResponse = await callXeroApi(
        () =>
          xero.accountingApi.getContacts(
            tenantId,
            undefined, // ifModifiedSince
            `EmailAddress="${member.email.replace(/"/g, "")}"` // where clause
          ),
        {
          operation: "getContacts",
          resourceType: "CONTACT",
          workflow: "findOrCreateXeroContact",
          context: `findOrCreateXeroContact searchByEmail(${member.email})`,
        }
      );
      const contacts = contactsResponse.body.contacts;
      if (contacts && contacts.length > 0) {
        const contactId = contacts[0].contactID!;
        await linkMatchedXeroContact(tx, {
          memberId,
          contactId,
          previousXeroContactId,
          repairExistingLink: options?.repairExistingLink,
          linkedVia: options?.repairExistingLink
            ? "email_match_repair"
            : "email_match",
          contactName: buildXeroContactDisplayName(contacts[0]),
        });
        return contactId;
      }
    } catch (searchErr) {
      // Rate-limit errors must propagate — swallowing them would cause a new
      // contact to be created and waste the daily quota further.
      if (searchErr instanceof XeroDailyLimitError) throw searchErr;
      // Any other error (network timeout, transient 5xx) is logged and we
      // fall through to contact creation. This is intentional: a failed
      // search is recoverable, whereas failing to create the invoice is not.
      logger.warn(
        { err: searchErr, memberId, email: member.email },
        "Xero email search failed; falling through to contact creation"
      );
    }

    // Create new contact
    const contact: Contact = {
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      emailAddress: member.email,
      phones: member.phoneNumber
        ? [
            {
              phoneType: Phone.PhoneTypeEnum.MOBILE,
              phoneCountryCode: member.phoneCountryCode || "",
              phoneAreaCode: member.phoneAreaCode || "",
              phoneNumber: member.phoneNumber,
            },
          ]
        : [],
      addresses: buildXeroAddresses(member),
    };

    const idempotencyKey = buildXeroIdempotencyKey(
      "member",
      memberId,
      "contact",
      "find-or-create",
      "v1"
    );
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "CREATE",
      localModel: "Member",
      localId: memberId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload: { contacts: [contact] },
      createdByMemberId: options?.createdByMemberId ?? null,
    });

    try {
      const response = await callXeroApi(
        () =>
          xero.accountingApi.createContacts(
            tenantId,
            { contacts: [contact] },
            undefined,
            idempotencyKey
          ),
        {
          operation: "createContacts",
          resourceType: "CONTACT",
          workflow: "findOrCreateXeroContact",
          context: `createContacts(findOrCreate ${memberId})`,
        }
      );
      const createdContact = response.body.contacts?.[0];
      if (!createdContact?.contactID) {
        throw new Error("Failed to create Xero contact");
      }

      await tx.member.update({
        where: { id: memberId },
        data: { xeroContactId: createdContact.contactID },
      });

      await completeXeroSyncOperation(operation.id, {
        responsePayload: response.body,
        xeroObjectType: "CONTACT",
        xeroObjectId: createdContact.contactID,
        xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
        extraLinks: [
          {
            localModel: "Member",
            localId: memberId,
            xeroObjectType: "CONTACT",
            xeroObjectId: createdContact.contactID,
            xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
            role: "CONTACT",
          },
        ],
      });

      return createdContact.contactID;
    } catch (error) {
      if (isDuplicateActiveXeroContactNameError(error)) {
        try {
          const matchedContact = await findExistingXeroContactByExactName({
            xero,
            tenantId,
            fullName: buildMemberFullName(member),
            contextPrefix: "findOrCreateXeroContact duplicate-name recovery",
          });

          if (matchedContact?.contactID) {
            await linkMatchedXeroContact(tx, {
              memberId,
              contactId: matchedContact.contactID,
              previousXeroContactId,
              repairExistingLink: options?.repairExistingLink,
              linkedVia: options?.repairExistingLink
                ? "name_match_repair"
                : "name_match",
              contactName: buildXeroContactDisplayName(matchedContact),
            });

            await completeXeroSyncOperation(operation.id, {
              responsePayload: {
                resolution: "linked_existing_contact_by_name",
                matchedBy: "name",
                duplicateCreateError: sanitizeForJson(error),
              },
              xeroObjectType: "CONTACT",
              xeroObjectId: matchedContact.contactID,
              xeroObjectUrl: buildXeroContactUrl(matchedContact.contactID),
              extraLinks: [
                {
                  localModel: "Member",
                  localId: memberId,
                  xeroObjectType: "CONTACT",
                  xeroObjectId: matchedContact.contactID,
                  xeroObjectUrl: buildXeroContactUrl(matchedContact.contactID),
                  role: "CONTACT",
                },
              ],
            });

            return matchedContact.contactID;
          }
        } catch (recoveryError) {
          await failXeroSyncOperation(operation.id, recoveryError, {
            duplicateCreateError: sanitizeForJson(error),
            recoveryError: sanitizeForJson(recoveryError),
          });
          throw recoveryError;
        }
      }

      await failXeroSyncOperation(operation.id, error);
      throw error;
    }
  });

  try {
    await syncManagedXeroContactGroupForMember(memberId, {
      createdByMemberId: options?.createdByMemberId,
    });
  } catch (error) {
    logger.error(
      { err: error, memberId, xeroContactId },
      "Failed to sync managed Xero contact groups after linking contact"
    );
  }

  return xeroContactId;
}

/**
 * Create a brand-new Xero contact for a member and link it locally.
 * Unlike findOrCreateXeroContact, this does not try to match existing
 * contacts by email.
 */
export async function createXeroContactForMember(
  memberId: string,
  options?: { createdByMemberId?: string }
): Promise<string> {
  const xeroContactId = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${memberId}))`;

    const member = await tx.member.findUnique({ where: { id: memberId } });
    if (!member) throw new Error(`Member not found: ${memberId}`);

    const missingFields = getMissingFieldsForXeroContactCreate(member);
    if (missingFields.length > 0) {
      throw new XeroContactValidationError(missingFields);
    }

    const { xero, tenantId } = await getAuthenticatedXeroClient();

    const contact: Contact = {
      name: `${member.firstName} ${member.lastName}`,
      firstName: member.firstName,
      lastName: member.lastName,
      emailAddress: member.email,
      phones: [
        {
          phoneType: Phone.PhoneTypeEnum.MOBILE,
          phoneCountryCode: member.phoneCountryCode || "",
          phoneAreaCode: member.phoneAreaCode || "",
          phoneNumber: member.phoneNumber || "",
        },
      ],
      addresses: buildXeroAddresses(member),
    };

    const idempotencyKey = buildXeroIdempotencyKey(
      "member",
      memberId,
      "contact",
      "create",
      "v1"
    );
    const operation = await startXeroSyncOperation({
      direction: "OUTBOUND",
      entityType: "CONTACT",
      operationType: "CREATE",
      localModel: "Member",
      localId: memberId,
      idempotencyKey,
      correlationKey: idempotencyKey,
      requestPayload: { contacts: [contact] },
      createdByMemberId: options?.createdByMemberId ?? null,
    });

    try {
      const response = await callXeroApi(
        () =>
          xero.accountingApi.createContacts(
            tenantId,
            { contacts: [contact] },
            undefined,
            idempotencyKey
          ),
        {
          operation: "createContacts",
          resourceType: "CONTACT",
          workflow: "createXeroContactForMember",
          context: `createContacts(member ${memberId})`,
        }
      );
      const createdContact = response.body.contacts?.[0];
      if (!createdContact?.contactID) {
        throw new Error("Failed to create Xero contact");
      }

      await tx.member.update({
        where: { id: memberId },
        data: { xeroContactId: createdContact.contactID },
      });

      await completeXeroSyncOperation(operation.id, {
        responsePayload: response.body,
        xeroObjectType: "CONTACT",
        xeroObjectId: createdContact.contactID,
        xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
        extraLinks: [
          {
            localModel: "Member",
            localId: memberId,
            xeroObjectType: "CONTACT",
            xeroObjectId: createdContact.contactID,
            xeroObjectUrl: buildXeroContactUrl(createdContact.contactID),
            role: "CONTACT",
          },
        ],
      });

      return createdContact.contactID;
    } catch (error) {
      await failXeroSyncOperation(operation.id, error);
      throw error;
    }
  });

  try {
    await syncManagedXeroContactGroupForMember(memberId, {
      createdByMemberId: options?.createdByMemberId,
    });
  } catch (error) {
    logger.error(
      { err: error, memberId, xeroContactId },
      "Failed to sync managed Xero contact groups after creating contact"
    );
  }

  return xeroContactId;
}

// ---------------------------------------------------------------------------
// First-invoice date helper (used by bulk sync joined-date backfill)
// ---------------------------------------------------------------------------

export async function getContactFirstInvoiceDate(
  xero: XeroClient,
  tenantId: string,
  contactID: string
): Promise<Date | null> {
  try {
    const response = await callXeroApi(
      () =>
        xero.accountingApi.getInvoices(
          tenantId,
          undefined, // ifModifiedSince
          undefined, // where
          "Date ASC", // order - earliest first
          undefined, // iDs
          undefined, // invoiceNumbers
          [contactID], // contactIDs
          undefined, // statuses
          1, // page
          false, // includeArchived
          false, // createdByMyApp
          undefined, // unitdp
          false // summaryOnly
        ),
      {
        operation: "getInvoices",
        resourceType: "INVOICE",
        workflow: "getContactFirstInvoiceDate",
        context: `getContactFirstInvoiceDate(${contactID})`,
      }
    );
    const invoices = response.body.invoices ?? [];
    if (invoices.length > 0 && invoices[0].date) {
      return new Date(invoices[0].date);
    }
    return null;
  } catch (err) {
    // Let daily limit errors propagate so callers can abort
    if (err instanceof XeroDailyLimitError) throw err;
    logger.warn(
      { err, contactID },
      "Failed to fetch first invoice date from Xero"
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// retryXeroWriteWithContactRepair
// ---------------------------------------------------------------------------

interface XeroContactRepairOperationKeys {
  idempotencyKey?: string | null;
  correlationKey?: string | null;
}

interface RetryXeroWriteWithContactRepairOptions<T> {
  memberId: string;
  currentContactId: string;
  workflow: string;
  operationId?: string;
  repairExistingLink?: boolean;
  createdByMemberId?: string;
  buildRequestPayload: (contactId: string) => unknown;
  buildOperationKeys?: (contactId: string) => XeroContactRepairOperationKeys;
  run: (input: {
    contactId: string;
    idempotencyKey?: string | null;
  }) => Promise<T>;
  repairContactLink?: (
    memberId: string,
    options?: FindOrCreateXeroContactOptions
  ) => Promise<string>;
  persistUpdatedOperation?: (input: {
    operationId: string;
    requestPayload: unknown;
    keys?: XeroContactRepairOperationKeys;
  }) => Promise<void>;
}

async function persistUpdatedXeroOperationRequest(input: {
  operationId: string;
  requestPayload: unknown;
  keys?: XeroContactRepairOperationKeys;
}) {
  await prisma.xeroSyncOperation.update({
    where: { id: input.operationId },
    data: {
      requestPayload: sanitizeForJson(input.requestPayload),
      idempotencyKey: input.keys?.idempotencyKey,
      correlationKey: input.keys?.correlationKey,
    },
  });
}

export async function retryXeroWriteWithContactRepair<T>(
  options: RetryXeroWriteWithContactRepairOptions<T>
): Promise<T> {
  const initialKeys = options.buildOperationKeys?.(options.currentContactId);

  try {
    return await options.run({
      contactId: options.currentContactId,
      idempotencyKey: initialKeys?.idempotencyKey ?? null,
    });
  } catch (error) {
    if (
      options.repairExistingLink ||
      !isRetryableXeroContactReferenceError(error)
    ) {
      throw error;
    }

    const repairContactLink =
      options.repairContactLink ?? findOrCreateXeroContact;
    const repairedContactId = await repairContactLink(options.memberId, {
      createdByMemberId: options.createdByMemberId,
      repairExistingLink: true,
    });
    const repairedPayload = options.buildRequestPayload(repairedContactId);
    const repairedKeys = options.buildOperationKeys?.(repairedContactId);

    if (options.operationId) {
      const persistUpdatedOperation =
        options.persistUpdatedOperation ?? persistUpdatedXeroOperationRequest;
      await persistUpdatedOperation({
        operationId: options.operationId,
        requestPayload: repairedPayload,
        keys: repairedKeys,
      });
    }

    logger.warn(
      {
        workflow: options.workflow,
        memberId: options.memberId,
        previousContactId: options.currentContactId,
        repairedContactId,
      },
      "Retrying Xero write after repairing a stale contact link"
    );

    return options.run({
      contactId: repairedContactId,
      idempotencyKey: repairedKeys?.idempotencyKey ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Update existing Xero contact
// ---------------------------------------------------------------------------

export async function updateXeroContact(
  xeroContactId: string,
  data: XeroContactUpdateData,
  options?: {
    localModel?: string;
    localId?: string;
    createdByMemberId?: string;
    preserveXeroName?: boolean;
  }
): Promise<void> {
  const { xero, tenantId } = await getAuthenticatedXeroClient();

  const buildContact = (contactId: string): Contact => {
    const contact: Contact = {
      contactID: contactId,
      emailAddress: data.email,
      phones: data.phoneNumber
        ? [
            {
              phoneType: Phone.PhoneTypeEnum.MOBILE,
              phoneCountryCode: data.phoneCountryCode || "",
              phoneAreaCode: data.phoneAreaCode || "",
              phoneNumber: data.phoneNumber,
            },
          ]
        : [],
      addresses: buildXeroAddresses(data),
    };

    if (!options?.preserveXeroName) {
      if (!data.firstName || !data.lastName) {
        throw new Error(
          "firstName and lastName are required when updating Xero contact names"
        );
      }

      contact.name = `${data.firstName} ${data.lastName}`;
      contact.firstName = data.firstName;
      contact.lastName = data.lastName;
    }

    return contact;
  };
  const buildRequestPayload = (contactId: string) => ({
    contacts: [buildContact(contactId)],
  });
  const buildOperationKeys = (contactId: string) => {
    const payloadHash = buildXeroPayloadHash(buildRequestPayload(contactId));
    const idempotencyKey = buildXeroIdempotencyKey(
      "contact",
      contactId,
      "update",
      payloadHash,
      "v2"
    );

    return {
      idempotencyKey,
      correlationKey: idempotencyKey,
    };
  };

  const initialPayload = buildRequestPayload(xeroContactId);
  const initialKeys = buildOperationKeys(xeroContactId);
  const operation = await startXeroSyncOperation({
    direction: "OUTBOUND",
    entityType: "CONTACT",
    operationType: "UPDATE",
    localModel: options?.localModel,
    localId: options?.localId,
    idempotencyKey: initialKeys.idempotencyKey,
    correlationKey: initialKeys.correlationKey,
    requestPayload: initialPayload,
    createdByMemberId: options?.createdByMemberId ?? null,
  });

  try {
    const response = await retryXeroWriteWithContactRepair({
      memberId:
        options?.localModel === "Member" && options.localId
          ? options.localId
          : "",
      currentContactId: xeroContactId,
      workflow: "updateXeroContact",
      operationId: operation.id,
      repairExistingLink:
        options?.localModel !== "Member" || !options.localId,
      createdByMemberId: options?.createdByMemberId,
      buildRequestPayload,
      buildOperationKeys,
      run: ({ contactId, idempotencyKey }) =>
        callXeroApi(
          () =>
            xero.accountingApi.updateContact(
              tenantId,
              contactId,
              buildRequestPayload(contactId),
              idempotencyKey ?? undefined
            ),
          {
            operation: "updateContact",
            resourceType: "CONTACT",
            workflow: "updateXeroContact",
            context: `updateContact(${contactId})`,
          }
        ),
    });
    const completedContactId =
      response.body.contacts?.[0]?.contactID ?? xeroContactId;

    await completeXeroSyncOperation(operation.id, {
      responsePayload: response.body,
      xeroObjectType: "CONTACT",
      xeroObjectId: completedContactId,
      xeroObjectUrl: buildXeroContactUrl(completedContactId),
      extraLinks:
        options?.localModel && options.localId
          ? [
              {
                localModel: options.localModel,
                localId: options.localId,
                xeroObjectType: "CONTACT",
                xeroObjectId: completedContactId,
                xeroObjectUrl: buildXeroContactUrl(completedContactId),
                role: "CONTACT",
              },
            ]
          : [],
    });
  } catch (error) {
    await failXeroSyncOperation(operation.id, error);
    throw error;
  }
}
