"use client";

import { BackLink } from "@/components/admin/back-link";
import { RefreshCw } from "lucide-react";
import { useHealthData } from "../health/_components/use-health-data";
import { EmailDeliverabilitySection } from "../health/_components/email-deliverability-section";

export default function EmailDeliverabilityPage() {
  const { data, loading, error, setError, lastRefresh, refresh } = useHealthData();

  return (
    <div className="p-6 space-y-6">
      <div>
        <BackLink href="/admin/health" label="System Health" />
        <div className="flex items-center justify-between mt-2">
          <h1 className="text-2xl font-bold text-foreground">
            Email Deliverability
          </h1>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              Last refresh: {lastRefresh.toLocaleTimeString("en-NZ")}
            </span>
            <button
              onClick={refresh}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-muted hover:bg-accent rounded-md transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Recipient suppressions and exhausted send failures.
        </p>
      </div>

      {loading && !data ? (
        <div className="animate-pulse space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 bg-muted rounded-lg" />
          ))}
        </div>
      ) : error && !data ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          Failed to load health data: {error}
        </div>
      ) : data ? (
        <>
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
              {error}
            </div>
          )}
          <EmailDeliverabilitySection
            emailDeliverability={data.emailDeliverability}
            emailFailures={data.emailFailures}
            adminAlertDelivery={data.adminAlertDelivery}
            tokenEmailRecovery={data.tokenEmailRecovery}
            onRefresh={refresh}
            onError={setError}
          />
        </>
      ) : null}
    </div>
  );
}
