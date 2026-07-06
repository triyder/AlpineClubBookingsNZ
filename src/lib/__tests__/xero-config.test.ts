import { afterEach, describe, expect, it } from "vitest";
import {
  XERO_REQUIRED_REPORT_OAUTH_SCOPES,
  getOperationalXeroConfig,
} from "@/lib/xero-config";

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

describe("xero-config", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("keeps operational Xero config on the existing env names", () => {
    process.env.XERO_CLIENT_ID = "operational-client";
    process.env.XERO_CLIENT_SECRET = "operational-secret";
    process.env.XERO_REDIRECT_URI = "https://example.com/api/admin/xero/callback";

    expect(getOperationalXeroConfig()).toMatchObject({
      clientId: "operational-client",
      clientSecret: "operational-secret",
      redirectUris: ["https://example.com/api/admin/xero/callback"],
    });
  });

  it("widens the xero-node OAuth HTTP timeout past the 3500ms library default", () => {
    delete process.env.XERO_HTTP_TIMEOUT_MS;

    expect(getOperationalXeroConfig().httpTimeout).toBe(10_000);
  });

  it("honours XERO_HTTP_TIMEOUT_MS and ignores non-positive or malformed values", () => {
    process.env.XERO_HTTP_TIMEOUT_MS = "20000";
    expect(getOperationalXeroConfig().httpTimeout).toBe(20_000);

    process.env.XERO_HTTP_TIMEOUT_MS = "0";
    expect(getOperationalXeroConfig().httpTimeout).toBe(10_000);

    process.env.XERO_HTTP_TIMEOUT_MS = "not-a-number";
    expect(getOperationalXeroConfig().httpTimeout).toBe(10_000);
  });

  it("includes only the granular report scopes finance sync uses", () => {
    const scopes = getOperationalXeroConfig().scopes;

    expect(scopes).toEqual(
      expect.arrayContaining([
        "openid",
        "profile",
        "email",
        "accounting.contacts",
        "accounting.invoices",
        "accounting.payments",
        "accounting.settings.read",
        "offline_access",
      ])
    );
    expect(scopes).not.toContain("accounting.reports.read");
    expect(scopes).toEqual(
      expect.arrayContaining([...XERO_REQUIRED_REPORT_OAUTH_SCOPES])
    );
    for (const forbiddenScope of [
      "accounting.attachments",
      "accounting.budgets.read",
      "accounting.journals.read",
      "accounting.reports.payroll.read",
      "assets",
      "files",
      "payroll.employees",
      "projects",
    ]) {
      expect(scopes).not.toContain(forbiddenScope);
    }
  });
});
