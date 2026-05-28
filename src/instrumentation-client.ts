import * as Sentry from "@sentry/nextjs";
import {
  redactSensitiveJson,
  redactSensitiveQueryParams,
  redactSensitiveText,
} from "@/lib/redact-sensitive-json";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || "",

  environment: process.env.NODE_ENV || "development",

  // Performance tracing
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.2 : 1.0,

  // Session Replay sampling
  replaysSessionSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,
  replaysOnErrorSampleRate: 1.0,

  integrations: [
    Sentry.breadcrumbsIntegration({
      console: true,
      dom: true,
      fetch: true,
      history: true,
    }),
    Sentry.replayIntegration(),
  ],

  // Scrub sensitive data from Sentry payloads
  beforeSend(event) {
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return null;

    if (event.message) {
      event.message = redactSensitiveText(event.message);
    }

    if (event.request?.url) {
      event.request.url = redactSensitiveText(event.request.url);
    }

    if (event.request?.query_string) {
      event.request.query_string = redactSensitiveQueryParams(
        event.request.query_string
      ) as typeof event.request.query_string;
    }

    if (event.request?.data) {
      event.request.data = redactSensitiveJson(event.request.data);
    }

    if (event.extra) {
      event.extra = redactSensitiveJson(event.extra) as typeof event.extra;
    }

    if (event.breadcrumbs) {
      event.breadcrumbs = redactSensitiveJson(
        event.breadcrumbs
      ) as typeof event.breadcrumbs;
    }

    if (event.exception?.values) {
      event.exception.values = redactSensitiveJson(
        event.exception.values
      ) as typeof event.exception.values;
    }

    return event;
  },

  beforeBreadcrumb(breadcrumb) {
    return redactSensitiveJson(breadcrumb) as typeof breadcrumb;
  },

  // Filter out noisy errors
  ignoreErrors: [
    "NEXT_NOT_FOUND",
    "NEXT_REDIRECT",
    "ResizeObserver loop",
    "Network request failed",
  ],
});

// Instrument Next.js router transitions for performance tracing
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
