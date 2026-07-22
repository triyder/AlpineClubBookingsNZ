"use client";

import Script from "next/script";
import { useEffect, useMemo, useState } from "react";
import { BarChart3, X } from "lucide-react";
import { Button } from "@/components/ui/button";

const CONSENT_STORAGE_KEY = "analytics-consent.v1";

type ConsentChoice = "accepted" | "declined";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

function readConsent(): ConsentChoice | null {
  try {
    const stored = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    return stored === "accepted" || stored === "declined" ? stored : null;
  } catch {
    return null;
  }
}

function writeConsent(choice: ConsentChoice) {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    // Private browsing / quota errors: the current render still honors choice.
  }
}

function updateAnalyticsConsent(choice: ConsentChoice) {
  window.dataLayer = window.dataLayer ?? [];
  window.gtag =
    window.gtag ??
    function gtag(...args: unknown[]) {
      window.dataLayer?.push(args);
    };
  window.gtag("consent", "update", {
    analytics_storage: choice === "accepted" ? "granted" : "denied",
  });
}

export function AnalyticsConsent({
  enabled,
  measurementId,
  nonce,
}: {
  enabled: boolean;
  measurementId?: string;
  nonce?: string;
}) {
  const cleanMeasurementId = measurementId?.trim();
  const [choice, setChoice] = useState<ConsentChoice | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const shouldRender = enabled && Boolean(cleanMeasurementId);
  const accepted = shouldRender && choice === "accepted";
  const consentBootstrap = useMemo(
    () => `
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
  ad_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
  analytics_storage: 'denied',
  wait_for_update: 500
});
`,
    [],
  );
  const gaConfig = useMemo(
    () => `
gtag('js', new Date());
gtag('config', ${JSON.stringify(cleanMeasurementId)}, { anonymize_ip: true });
`,
    [cleanMeasurementId],
  );

  useEffect(() => {
    if (!shouldRender) return;
    const stored = readConsent();
    setChoice(stored);
    setHydrated(true);
    if (stored) updateAnalyticsConsent(stored);
  }, [shouldRender]);

  if (!shouldRender) {
    return null;
  }

  function setConsent(nextChoice: ConsentChoice) {
    setChoice(nextChoice);
    writeConsent(nextChoice);
    updateAnalyticsConsent(nextChoice);
  }

  return (
    <>
      <Script id="ga-consent-default" nonce={nonce} strategy="afterInteractive">
        {consentBootstrap}
      </Script>

      {accepted && (
        <>
          <Script
            id="ga4-loader"
            nonce={nonce}
            src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
              cleanMeasurementId as string,
            )}`}
            strategy="afterInteractive"
          />
          <Script id="ga4-config" nonce={nonce} strategy="afterInteractive">
            {gaConfig}
          </Script>
        </>
      )}

      {hydrated && choice === null && (
        <div
          role="dialog"
          aria-label="Analytics cookie consent"
          className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-card px-4 py-4 shadow-lg backdrop-blur"
        >
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 sm:flex-row sm:items-center">
            <BarChart3
              aria-hidden="true"
              className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block"
            />
            <p className="flex-1 text-sm leading-6 text-muted-foreground">
              We use optional Google Analytics to understand aggregate site use.
              It runs only if you accept.
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button type="button" onClick={() => setConsent("accepted")}>
                Accept
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConsent("declined")}
              >
                Decline
              </Button>
              <button
                type="button"
                aria-label="Close analytics consent banner"
                onClick={() => setConsent("declined")}
                className="flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
