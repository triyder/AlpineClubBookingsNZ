import { describe, expect, it } from "vitest";
import { getXeroApiErrorInfo } from "../xero-api-errors";

describe("getXeroApiErrorInfo", () => {
  it("maps XeroDailyLimitError by name to a friendly 429 response", () => {
    const error = new Error("Xero daily API limit reached. Retry after 86400 seconds.");
    error.name = "XeroDailyLimitError";

    expect(getXeroApiErrorInfo(error, "Fallback failure")).toEqual({
      handled: true,
      status: 429,
      clientMessage: "Xero daily API limit reached. Please try again tomorrow.",
      diagnosticMessage: "Xero daily API limit reached. Retry after 86400 seconds.",
    });
  });

  it("maps raw 429 errors to the short rate-limit message", () => {
    expect(
      getXeroApiErrorInfo(
        {
          response: {
            statusCode: 429,
            headers: {
              "retry-after": "60",
            },
          },
        },
        "Fallback failure"
      )
    ).toEqual({
      handled: true,
      status: 429,
      clientMessage: "Xero rate limit hit. Please wait a moment and try again.",
      diagnosticMessage: "Fallback failure",
    });
  });

  it("maps wrapped JSON 429/day errors carried in Error.message", () => {
    const error = new Error(
      JSON.stringify({
        response: {
          statusCode: 429,
          headers: {
            "retry-after": "12328",
            "x-rate-limit-problem": "day",
          },
        },
      })
    );

    expect(getXeroApiErrorInfo(error, "Fallback failure")).toEqual({
      handled: true,
      status: 429,
      clientMessage: "Xero daily API limit reached. Please try again tomorrow.",
      diagnosticMessage: error.message,
    });
  });

  it("maps 401 and 403 to reconnect guidance", () => {
    expect(
      getXeroApiErrorInfo(
        {
          response: {
            statusCode: 401,
          },
        },
        "Fallback failure"
      )
    ).toEqual({
      handled: true,
      status: 401,
      clientMessage: "Xero connection expired. Please reconnect Xero from the admin panel.",
      diagnosticMessage: "Fallback failure",
    });

    expect(
      getXeroApiErrorInfo(
        {
          response: {
            statusCode: 403,
          },
        },
        "Fallback failure"
      )
    ).toEqual({
      handled: true,
      status: 401,
      clientMessage: "Xero connection expired. Please reconnect Xero from the admin panel.",
      diagnosticMessage: "Fallback failure",
    });
  });

  it("maps Xero 5xx errors to concise upstream retry guidance", () => {
    const error = new Error(
      JSON.stringify({
        response: {
          statusCode: 500,
          body: {
            Detail: "An error occurred in Xero.",
          },
          headers: {
            "xero-correlation-id": "correlation-123",
          },
        },
      })
    );

    expect(getXeroApiErrorInfo(error, "Fallback failure")).toEqual({
      handled: false,
      status: 502,
      clientMessage: "Xero is temporarily unavailable. Please try again in a few minutes.",
      diagnosticMessage:
        "Xero is temporarily unavailable (HTTP 500). An error occurred in Xero. Please try again in a few minutes. Xero correlation ID: correlation-123.",
    });
  });

  it("maps XeroReconnectRequiredError by name to the 401-style reconnect guidance", () => {
    const error = new Error("Xero token refresh failed. Please reconnect Xero via the admin panel.");
    error.name = "XeroReconnectRequiredError";

    expect(getXeroApiErrorInfo(error, "Fallback failure")).toEqual({
      handled: true,
      status: 401,
      clientMessage: "Xero connection expired. Please reconnect Xero from the admin panel.",
      diagnosticMessage: "Xero token refresh failed. Please reconnect Xero via the admin panel.",
    });
  });

  it("maps XeroTokenDecryptError (undecryptable stored token) to the same 401-style reconnect guidance", () => {
    // #2079: a token row left unreadable by the env→DB upgrade or an auth-secret
    // change must surface the clean reconnect prompt, not an opaque 500.
    const error = new Error("Stored Xero token could not be decrypted");
    error.name = "XeroTokenDecryptError";

    expect(getXeroApiErrorInfo(error, "Fallback failure")).toEqual({
      handled: true,
      status: 401,
      clientMessage: "Xero connection expired. Please reconnect Xero from the admin panel.",
      diagnosticMessage: "Stored Xero token could not be decrypted",
    });
  });

  it("maps local transient outage cooldown errors to a friendly 503 response", () => {
    const error = new Error(
      "Xero is temporarily unavailable. Suppressing further Xero calls for 120 seconds to protect API quota."
    );
    error.name = "XeroTransientOutageError";

    expect(getXeroApiErrorInfo(error, "Fallback failure")).toEqual({
      handled: true,
      status: 503,
      clientMessage: "Xero is temporarily unavailable. Please try again shortly.",
      diagnosticMessage:
        "Xero is temporarily unavailable. Suppressing further Xero calls for 120 seconds to protect API quota.",
    });
  });

  it("falls back to the original error message for unknown failures", () => {
    expect(getXeroApiErrorInfo(new Error("Boom"), "Fallback failure")).toEqual({
      handled: false,
      status: 500,
      clientMessage: "Fallback failure",
      diagnosticMessage: "Boom",
    });
  });
});
