import { beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Phone } from "xero-node";

// -----------------------------------------------------------------------------
// #2089: createXeroContactForMember must succeed for a sparse member (name +
// email only). The payload it sends to Xero must contain NO empty address
// blocks and NO empty-string phone entry, and the member-scoped idempotency key
// must be unchanged. A member missing name/email is still rejected up-front by
// the shrunk create gate (XeroContactValidationError).
// -----------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  memberFindUnique: vi.fn(),
  txMemberUpdate: vi.fn(),
  txExecuteRaw: vi.fn(),
  transaction: vi.fn(),
  createContacts: vi.fn(),
  getAuthenticatedXeroClient: vi.fn(),
  startXeroSyncOperation: vi.fn(),
  completeXeroSyncOperation: vi.fn(),
  failXeroSyncOperation: vi.fn(),
  upsertXeroObjectLink: vi.fn(),
  syncManagedXeroContactGroupForMember: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    $transaction: mocks.transaction,
  },
}));

vi.mock("@/lib/xero-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-sync")>();
  return {
    ...actual,
    // Keep the REAL buildXeroIdempotencyKey so we can assert the create key is
    // unchanged against the real builder.
    startXeroSyncOperation: mocks.startXeroSyncOperation,
    completeXeroSyncOperation: mocks.completeXeroSyncOperation,
    failXeroSyncOperation: mocks.failXeroSyncOperation,
    upsertXeroObjectLink: mocks.upsertXeroObjectLink,
  };
});

vi.mock("@/lib/xero-api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/xero-api-client")>();
  return {
    ...actual,
    getAuthenticatedXeroClient: mocks.getAuthenticatedXeroClient,
    callXeroApi: vi.fn((fn: () => unknown) => fn()),
  };
});

vi.mock("@/lib/xero-contact-groups", () => ({
  syncManagedXeroContactGroupForMember:
    mocks.syncManagedXeroContactGroupForMember,
}));

vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { createXeroContactForMember } from "@/lib/xero-contacts";
import { XeroContactValidationError } from "@/lib/xero-contacts";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

const SPARSE_MEMBER = {
  id: "member-1",
  firstName: "Alice",
  lastName: "Example",
  email: "alice@example.org",
  phoneCountryCode: null,
  phoneAreaCode: null,
  phoneNumber: null,
  streetAddressLine1: null,
  streetAddressLine2: null,
  streetCity: null,
  streetRegion: null,
  streetPostalCode: null,
  streetCountry: null,
  postalAddressLine1: null,
  postalAddressLine2: null,
  postalCity: null,
  postalRegion: null,
  postalPostalCode: null,
  postalCountry: null,
  dateOfBirth: null,
  joinedDate: null,
  xeroContactId: null,
};

function primeHappyPath(member: Record<string, unknown>) {
  mocks.memberFindUnique.mockResolvedValue({ ...member });
  mocks.getAuthenticatedXeroClient.mockResolvedValue({
    xero: { accountingApi: { createContacts: mocks.createContacts } },
    tenantId: "tenant-1",
  });
  mocks.createContacts.mockResolvedValue({
    body: { contacts: [{ contactID: "contact-new", name: "Alice Example" }] },
  });
  mocks.startXeroSyncOperation.mockResolvedValue({ id: "op-1" });
  mocks.completeXeroSyncOperation.mockResolvedValue(undefined);
  mocks.failXeroSyncOperation.mockResolvedValue(undefined);
  mocks.upsertXeroObjectLink.mockResolvedValue({ id: "link-1" });
  mocks.syncManagedXeroContactGroupForMember.mockResolvedValue(undefined);
  mocks.txExecuteRaw.mockResolvedValue(undefined);
  mocks.txMemberUpdate.mockResolvedValue({ id: member.id });
  mocks.transaction.mockImplementation(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $executeRaw: mocks.txExecuteRaw,
        member: { update: mocks.txMemberUpdate },
      })
  );
}

function sentContact() {
  const [, body] = mocks.createContacts.mock.calls[0] as [
    string,
    { contacts: Array<Record<string, unknown>> },
    unknown,
    string,
  ];
  return body.contacts[0];
}

describe("createXeroContactForMember payload hygiene (#2089)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a sparse member with no address blocks and no phone entry", async () => {
    primeHappyPath(SPARSE_MEMBER);

    const result = await createXeroContactForMember("member-1");

    expect(result).toBe("contact-new");
    expect(mocks.createContacts).toHaveBeenCalledTimes(1);

    const contact = sentContact();
    expect(contact.name).toBe("Alice Example");
    expect(contact.emailAddress).toBe("alice@example.org");
    // No empty address blocks.
    expect(contact.addresses).toEqual([]);
    // No empty-string phone entry.
    expect(contact.phones).toEqual([]);
  });

  it("keeps the member-scoped create idempotency key unchanged", async () => {
    primeHappyPath(SPARSE_MEMBER);

    await createXeroContactForMember("member-1");

    const call = mocks.createContacts.mock.calls[0];
    // createContacts(tenantId, body, undefined, idempotencyKey)
    expect(call[3]).toBe(
      buildXeroIdempotencyKey("member", "member-1", "contact", "create", "v1")
    );
    // startXeroSyncOperation carries the same key.
    expect(mocks.startXeroSyncOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: buildXeroIdempotencyKey(
          "member",
          "member-1",
          "contact",
          "create",
          "v1"
        ),
        operationType: "CREATE",
        entityType: "CONTACT",
      })
    );
  });

  it("still sends a MOBILE phone block when any phone part is present", async () => {
    primeHappyPath({
      ...SPARSE_MEMBER,
      phoneCountryCode: "64",
      phoneAreaCode: "27",
      phoneNumber: "5551234",
    });

    await createXeroContactForMember("member-1");

    const contact = sentContact();
    expect(contact.phones).toEqual([
      {
        phoneType: Phone.PhoneTypeEnum.MOBILE,
        phoneCountryCode: "64",
        phoneAreaCode: "27",
        phoneNumber: "5551234",
      },
    ]);
  });

  it("sends a phone block even when only the area code is present", async () => {
    primeHappyPath({ ...SPARSE_MEMBER, phoneAreaCode: "27" });

    await createXeroContactForMember("member-1");

    expect(sentContact().phones).toEqual([
      {
        phoneType: Phone.PhoneTypeEnum.MOBILE,
        phoneCountryCode: "",
        phoneAreaCode: "27",
        phoneNumber: "",
      },
    ]);
  });

  it("sends both address blocks when the member has full addresses", async () => {
    primeHappyPath({
      ...SPARSE_MEMBER,
      streetAddressLine1: "1 Main Rd",
      streetCity: "Wellington",
      postalAddressLine1: "PO Box 9",
      postalCity: "Wellington",
    });

    await createXeroContactForMember("member-1");

    const addresses = sentContact().addresses as Array<{ addressType: string }>;
    expect(addresses).toHaveLength(2);
    expect(addresses.map((a) => a.addressType)).toEqual([
      Address.AddressTypeEnum.STREET,
      Address.AddressTypeEnum.POBOX,
    ]);
  });

  it("never sends DOB or joined date, even when the member has both", async () => {
    // A member with real dateOfBirth and joinedDate values must still produce a
    // create payload that carries neither — joined date only ever round-trips
    // through the import/backfill path's company-number field, never on create.
    primeHappyPath({
      ...SPARSE_MEMBER,
      dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
      joinedDate: new Date("2024-05-01T00:00:00.000Z"),
    });

    await createXeroContactForMember("member-1");

    const contact = sentContact();
    // None of the date-bearing Xero contact fields may appear.
    expect(contact).not.toHaveProperty("companyNumber");
    expect(contact).not.toHaveProperty("dateOfBirth");
    expect(contact).not.toHaveProperty("validationDate");
    // The rest of the payload is exactly the sparse name + email shape.
    expect(contact.name).toBe("Alice Example");
    expect(contact.firstName).toBe("Alice");
    expect(contact.lastName).toBe("Example");
    expect(contact.emailAddress).toBe("alice@example.org");
    expect(contact.phones).toEqual([]);
    expect(contact.addresses).toEqual([]);
    // Exactly the six known keys — nothing date-related leaked in.
    expect(Object.keys(contact).sort()).toEqual([
      "addresses",
      "emailAddress",
      "firstName",
      "lastName",
      "name",
      "phones",
    ]);
  });

  it("rejects a member missing email before any Xero call", async () => {
    primeHappyPath({ ...SPARSE_MEMBER, email: "" });

    await expect(createXeroContactForMember("member-1")).rejects.toBeInstanceOf(
      XeroContactValidationError
    );
    await expect(
      createXeroContactForMember("member-1")
    ).rejects.toMatchObject({ missingFields: ["Email"] });
    expect(mocks.createContacts).not.toHaveBeenCalled();
    expect(mocks.getAuthenticatedXeroClient).not.toHaveBeenCalled();
  });

  it("rejects a member missing name before any Xero call", async () => {
    primeHappyPath({ ...SPARSE_MEMBER, firstName: "", lastName: "" });

    await expect(
      createXeroContactForMember("member-1")
    ).rejects.toMatchObject({ missingFields: ["First Name", "Last Name"] });
    expect(mocks.createContacts).not.toHaveBeenCalled();
  });
});
