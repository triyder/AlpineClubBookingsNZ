import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  images: {
    deviceSizes: [640, 750, 828, 1080, 1200, 1536, 1920, 2048, 3840],
  },
  output: "standalone",
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
};

// Warn at build time if Sentry is partially configured
if (process.env.SENTRY_DSN && !process.env.SENTRY_AUTH_TOKEN) {
  console.warn(
    "\x1b[33m⚠ SENTRY_DSN is set but SENTRY_AUTH_TOKEN is missing — source maps will not be uploaded. Production stack traces will be unreadable.\x1b[0m"
  );
}

export default withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG || "",
  project: process.env.SENTRY_PROJECT || "",
});
