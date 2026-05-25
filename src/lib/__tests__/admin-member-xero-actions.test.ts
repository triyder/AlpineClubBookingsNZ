import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkMemberXeroContact,
  pushMemberToXero,
  searchXeroContacts,
  unlinkMemberXeroContact,
} from "@/lib/admin-member-xero-actions";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

function jsonResponse(payload: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe("searchXeroContacts", () => {
  it("encodes the query and returns the contacts list", async () => {
    const contacts = [{ contactId: "c1", name: "Jane Smith", email: null, isLinked: false }];
    fetchMock.mockResolvedValue(jsonResponse({ contacts }));

    const result = await searchXeroContacts("jane smith");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/xero/search-contacts?q=jane%20smith",
    );
    expect(result).toEqual(contacts);
  });

  it("returns an empty array when the response has no contacts field", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    const result = await searchXeroContacts("nobody");

    expect(result).toEqual([]);
  });

  it("throws with the server error message when the response is not ok", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Xero is not connected" }, { ok: false, status: 503 }),
    );

    await expect(searchXeroContacts("anyone")).rejects.toThrow("Xero is not connected");
  });
});

describe("linkMemberXeroContact", () => {
  it("posts the contact id and returns the parsed body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ contactName: "Jane Smith" }));

    const result = await linkMemberXeroContact("mem_1", "contact_1");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/members/mem_1/xero-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ xeroContactId: "contact_1" }),
    });
    expect(result).toEqual({ contactName: "Jane Smith" });
  });

  it("throws with the server error message when the response is not ok", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Contact already linked" }, { ok: false, status: 409 }),
    );

    await expect(linkMemberXeroContact("mem_1", "contact_1")).rejects.toThrow(
      "Contact already linked",
    );
  });
});

describe("unlinkMemberXeroContact", () => {
  it("issues a POST without a body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await unlinkMemberXeroContact("mem_1");

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/members/mem_1/xero-unlink", {
      method: "POST",
    });
  });

  it("throws with the server error message when the response is not ok", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Member not found" }, { ok: false, status: 404 }),
    );

    await expect(unlinkMemberXeroContact("mem_1")).rejects.toThrow("Member not found");
  });
});

describe("pushMemberToXero", () => {
  it("posts the entrance fee invoice options and returns the created data", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        xeroContactId: "contact_new",
        entranceFeeInvoiceQueued: true,
      }),
    );

    const result = await pushMemberToXero("mem_1", {
      createEntranceFeeInvoice: true,
      entranceFeeInvoiceDecision: "CREATE",
      entranceFeeInvoiceAmountCents: 7500,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/admin/members/mem_1/xero-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        createEntranceFeeInvoice: true,
        entranceFeeInvoiceDecision: "CREATE",
        entranceFeeInvoiceSkipReason: undefined,
        entranceFeeInvoiceAmountCents: 7500,
        entranceFeeInvoiceNarration: undefined,
        forceCreate: false,
      }),
    });
    expect(result).toEqual({
      status: "created",
      data: { xeroContactId: "contact_new", entranceFeeInvoiceQueued: true },
    });
  });

  it("returns needsDecision when the server replies 409 with suggested contacts", async () => {
    const suggestedContacts = [
      { contactId: "contact_existing", name: "J. Smith", email: null, isLinked: false },
    ];
    fetchMock.mockResolvedValue(
      jsonResponse({ suggestedContacts }, { ok: false, status: 409 }),
    );

    const result = await pushMemberToXero("mem_1", { createEntranceFeeInvoice: false });

    expect(result).toEqual({ status: "needsDecision", suggestedContacts });
  });

  it("throws with the server error message on a non-409 failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Xero rate limited" }, { ok: false, status: 429 }),
    );

    await expect(
      pushMemberToXero("mem_1", { createEntranceFeeInvoice: false }),
    ).rejects.toThrow("Xero rate limited");
  });

  it("passes forceCreate through and includes the skip-reason narration fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ xeroContactId: "contact_new" }));

    await pushMemberToXero("mem_1", {
      createEntranceFeeInvoice: false,
      entranceFeeInvoiceDecision: "SKIP",
      entranceFeeInvoiceSkipReason: "Already paid in 2018",
      forceCreate: true,
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({
      createEntranceFeeInvoice: false,
      entranceFeeInvoiceDecision: "SKIP",
      entranceFeeInvoiceSkipReason: "Already paid in 2018",
      entranceFeeInvoiceAmountCents: undefined,
      entranceFeeInvoiceNarration: undefined,
      forceCreate: true,
    });
  });
});
