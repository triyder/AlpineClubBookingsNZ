import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { XeroClient } from "xero-node";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/xero-api-client", () => ({ callXeroApi: vi.fn(async (fn: () => Promise<unknown>) => fn()) }));
import { callXeroApi } from "@/lib/xero-api-client";
import { readXeroInvoicePayableObservations } from "@/lib/xero-invoice-observation-read";

const id = "11111111-1111-4111-8111-111111111111";
const xero = { readTokenSet: () => ({ access_token: "synthetic-token" }), accountingApi: { basePath: "https://synthetic.example/api.xro/2.0" } } as unknown as XeroClient;
const input = { xero, tenantId: "synthetic-tenant", invoiceIds: [id], currencyCode: "NZD" };
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

describe("cancellable accounting observation", () => {
  it("requests scoped JSON once through canonical metering with zero retries", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ Invoices: [{ InvoiceID: id, InvoiceNumber: "INV-1", Type: "ACCREC", CurrencyCode: "NZD", Status: "PAID", AmountDue: 0 }] })));
    expect((await readXeroInvoicePayableObservations(input, { fetch: transport }))[0]?.kind).toBe("settled");
    const [url, options] = transport.mock.calls[0]!;
    expect(String(url)).toContain(`IDs=${id}`);
    expect(options).toMatchObject({ cache: "no-store", headers: { Accept: "application/json", "Xero-Tenant-Id": "synthetic-tenant" } });
    expect(callXeroApi).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ operation: "getInvoices", maxRetries: 0, maxTransientRetries: 0, maxWaitSec: 0, armTransientBreaker: false }));
  });
  it.each(["request", "body"])("aborts during %s and does not leave a request running", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      signal = options?.signal ?? undefined;
      const blocked = () => new Promise<never>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      if (phase === "request") return blocked();
      return { ok: true, json: blocked } as unknown as Response;
    });
    const pending = readXeroInvoicePayableObservations(input, { fetch: transport });
    const rejected = expect(pending).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("refuses oversized or unsafe identity input before HTTP", async () => {
    const transport = vi.fn<typeof fetch>();
    await expect(readXeroInvoicePayableObservations({ ...input, invoiceIds: Array.from({ length: 21 }, (_, n) => `${n}`) }, { fetch: transport })).rejects.toThrow("INV-INT-003");
    await expect(readXeroInvoicePayableObservations({ ...input, invoiceIds: ["not-an-id"] }, { fetch: transport })).rejects.toThrow("INV-INT-003");
    expect(transport).not.toHaveBeenCalled();
  });
  it("passes safe status and cooldown headers, without reading an error body", async () => {
    const body = vi.fn();
    const transport = vi.fn<typeof fetch>().mockResolvedValue({ ok: false, status: 429, headers: new Headers({ "retry-after": "120", "x-rate-limit-problem": "day" }), json: body } as unknown as Response);
    await expect(readXeroInvoicePayableObservations(input, { fetch: transport })).rejects.toMatchObject({ response: { status: 429, headers: { "retry-after": "120", "x-rate-limit-problem": "day" } } });
    expect(body).not.toHaveBeenCalled();
  });
});
