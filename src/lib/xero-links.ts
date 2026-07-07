interface XeroUrlOptions {
  shortCode?: string | null;
}

function buildXeroUrl(path: string, options?: XeroUrlOptions): string {
  if (options?.shortCode) {
    const shortCode = encodeURIComponent(options.shortCode);
    const redirect = encodeURIComponent(path);
    return `https://go.xero.com/organisationlogin/default.aspx?shortcode=${shortCode}&redirecturl=${redirect}`;
  }

  return `https://go.xero.com${path}`;
}

export function buildXeroContactUrl(
  contactId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(`/Contacts/View/${encodeURIComponent(contactId)}`, options);
}

export function buildXeroInvoiceUrl(
  invoiceId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(
    `/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`,
    options
  );
}

export function buildXeroCreditNoteUrl(
  creditNoteId: string,
  options?: XeroUrlOptions
): string {
  return buildXeroUrl(
    `/AccountsReceivable/ViewCreditNote.aspx?creditNoteID=${encodeURIComponent(creditNoteId)}`,
    options
  );
}

/**
 * Xero's report centre ("Accounting → Reports" in the web app). Specific
 * report runs (Profit and Loss, Balance Sheet) need a per-organisation report
 * GUID or the org short code, neither of which we store, so dashboard "open
 * in Xero" links land on the hub — both reports are one click away.
 *
 * Uses the session-scoped classic path `/Reports/`, which resolves against the
 * user's currently logged-in organisation. The new-app path `/app/reports`
 * 404s: the new app requires the org short code in the URL
 * (`/app/!{shortCode}/…`), and the finance dashboard deliberately avoids the
 * live Xero call that fetching the short code would need on every page load.
 */
export function buildXeroReportsUrl(options?: XeroUrlOptions): string {
  return buildXeroUrl("/Reports/", options);
}

export function buildXeroObjectUrl(
  objectType: string,
  objectId: string,
  options?: XeroUrlOptions
): string | null {
  switch (objectType) {
    case "CONTACT":
      return buildXeroContactUrl(objectId, options);
    case "INVOICE":
    case "SUBSCRIPTION":
      return buildXeroInvoiceUrl(objectId, options);
    case "CREDIT_NOTE":
    case "CREDITNOTE":
      return buildXeroCreditNoteUrl(objectId, options);
    default:
      return null;
  }
}
