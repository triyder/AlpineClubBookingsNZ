import "server-only";
import type { XeroClient } from "xero-node";
import { z } from "zod";
import { callXeroApi } from "@/lib/xero-api-client";
import { observeInvoicePayables, type InvoicePayableObservation } from "@/lib/xero-invoice-payable-observation";

export const INVOICE_OBSERVATION_BATCH_SIZE = 20;
const ACCOUNTING_READ_DEADLINE_MS = 5_000;

/** Authentication happens before this seam and remains outside its accounting deadline. */
export async function readXeroInvoicePayableObservations(input: {
  xero: XeroClient;
  tenantId: string;
  invoiceIds: readonly string[];
  currencyCode: string;
}, deps: { fetch: typeof fetch } = { fetch }): Promise<InvoicePayableObservation[]> {
  const { xero, tenantId, invoiceIds, currencyCode } = input;
  if (invoiceIds.length === 0 || invoiceIds.length > INVOICE_OBSERVATION_BATCH_SIZE ||
      new Set(invoiceIds).size !== invoiceIds.length || invoiceIds.some((id) => !z.uuid().safeParse(id).success)) {
    throw new Error("INV-INT-003: invoice observation requires one scoped batch of at most 20 distinct invoice IDs");
  }
  const token = xero.readTokenSet().access_token;
  if (!token) throw new Error("Xero authentication is unavailable");
  const url = new URL(`${xero.accountingApi.basePath}/Invoices`);
  url.searchParams.set("IDs", invoiceIds.join(","));
  // Native fetch owns cancellation through headers AND response-body consumption.
  const response = await callXeroApi(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACCOUNTING_READ_DEADLINE_MS);
    try {
      const result = await deps.fetch(url, {
        method: "GET", cache: "no-store", signal: controller.signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Xero-Tenant-Id": tenantId },
      });
      if (!result.ok) {
        await result.body?.cancel();
        // Only the canonical status/header shape; never provider bodies or credentials.
        throw Object.assign(new Error("Xero invoice observation unavailable"), {
          response: { status: result.status, headers: Object.fromEntries(result.headers) },
        });
      }
      return await result.json() as unknown;
    } finally {
      clearTimeout(timer);
    }
  }, {
    operation: "getInvoices", resourceType: "INVOICE", workflow: "bookingSupplementaryInvoiceObservation",
    maxRetries: 0, maxTransientRetries: 0, maxWaitSec: 0, armTransientBreaker: false,
  });
  return observeInvoicePayables(response, invoiceIds, currencyCode, new Date().toISOString());
}
