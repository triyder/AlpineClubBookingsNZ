"use client";

import Link from "next/link";
import {
  Activity,
  Database,
  CreditCard,
  RefreshCw,
  Mail,
  Server,
  AlertTriangle,
  Webhook,
  Clock,
  ChevronRight,
} from "lucide-react";
import { StatusBadge, StatusIcon, formatUptime, formatDate } from "./_components/shared";
import { useHealthData } from "./_components/use-health-data";
import type { HealthCheck } from "./_components/types";

export default function AdminHealthPage() {
  const { data, loading, error, lastRefresh, refresh } = useHealthData();

  if (loading) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">System Health</h1>
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-slate-100 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">System Health</h1>
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
          Failed to load health data: {error}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { health, webhookStats, recentWebhooks, systemInfo } = data;
  const checkEntries = Object.entries(health.checks) as [string, HealthCheck][];
  const checkIcons: Record<string, typeof Database> = {
    db: Database,
    config: AlertTriangle,
    stripe: CreditCard,
    xero: RefreshCw,
    smtp: Mail,
    paymentRecovery: CreditCard,
  };
  // Friendly names for check keys the backend reports in camelCase.
  const checkLabels: Record<string, string> = {
    db: "Database",
    smtp: "SMTP",
    paymentRecovery: "Payment recovery",
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">System Health</h1>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-500">
            Last refresh: {lastRefresh.toLocaleTimeString("en-NZ")}
          </span>
          <button
            onClick={refresh}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-slate-100 hover:bg-slate-200 rounded-md transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>
      </div>

      {/* Overall Status */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-4">
        <StatusIcon status={health.status} />
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            System is {health.status}
          </h2>
          <p className="text-sm text-slate-500">
            Version {systemInfo.version} &middot; Node {systemInfo.nodeVersion} &middot; Uptime {formatUptime(systemInfo.uptime)}
          </p>
        </div>
      </div>

      {/* Service Checks */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Service Checks
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {checkEntries.map(([name, check]) => {
            const Icon = checkIcons[name] || Server;
            return (
              <div key={name} className="bg-white border rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-slate-500" />
                    <span className="font-medium text-slate-900 capitalize">
                      {checkLabels[name] ?? name}
                    </span>
                  </div>
                  <StatusBadge status={check.status} />
                </div>
                <p className="text-sm text-slate-500">
                  {check.status === "ok"
                    ? `${check.latencyMs}ms`
                    : check.error || "Error"}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Related monitoring */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Link
          href="/admin/email-deliverability"
          className="bg-white border rounded-lg p-4 flex items-center justify-between hover:border-brand-gold/70 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Mail className="h-5 w-5 text-slate-500" />
            <div>
              <p className="font-medium text-slate-900">Email Deliverability</p>
              <p className="text-sm text-slate-500">Suppressions &amp; exhausted failures</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-slate-400" />
        </Link>
        <Link
          href="/admin/background-jobs"
          className="bg-white border rounded-lg p-4 flex items-center justify-between hover:border-brand-gold/70 transition-colors"
        >
          <div className="flex items-center gap-3">
            <Clock className="h-5 w-5 text-slate-500" />
            <div>
              <p className="font-medium text-slate-900">Background Jobs</p>
              <p className="text-sm text-slate-500">Cron job health &amp; run history</p>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 text-slate-400" />
        </Link>
      </div>

      {/* System Info */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Server className="h-5 w-5" />
          System Info
        </h2>
        <div className="bg-white border rounded-lg p-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-slate-500">Memory (RSS)</p>
              <p className="text-lg font-medium">{systemInfo.memoryMb.rss} MB</p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Heap Used</p>
              <p className="text-lg font-medium">
                {systemInfo.memoryMb.heapUsed} / {systemInfo.memoryMb.heapTotal} MB
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Sentry</p>
              <p className="text-lg font-medium">
                {systemInfo.sentryConfigured ? (
                  <span className="text-green-600">Connected</span>
                ) : (
                  <span className="text-slate-400">Not configured</span>
                )}
              </p>
            </div>
            <div>
              <p className="text-sm text-slate-500">Uptime</p>
              <p className="text-lg font-medium">{formatUptime(systemInfo.uptime)}</p>
            </div>
          </div>
          {systemInfo.sentryDashboardUrl && (
            <div className="mt-3 pt-3 border-t">
              <a
                href={systemInfo.sentryDashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:underline"
              >
                Open Sentry Dashboard
              </a>
            </div>
          )}
          {systemInfo.sentryConfigWarning && (
            <div className="mt-3 pt-3 border-t text-sm text-amber-700 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{systemInfo.sentryConfigWarning}</span>
            </div>
          )}
        </div>
      </div>

      {/* Webhook Stats */}
      <div>
        <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
          <Webhook className="h-5 w-5" />
          Webhooks (Last 24h)
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          {Object.keys(webhookStats).length === 0 ? (
            <div className="bg-white border rounded-lg p-4 text-slate-500 col-span-2">
              No webhook activity in the last 24 hours.
            </div>
          ) : (
            Object.entries(webhookStats).map(([source, stats]) => (
              <div key={source} className="bg-white border rounded-lg p-4">
                <h3 className="font-medium text-slate-900 capitalize mb-2">{source}</h3>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-2xl font-bold text-green-600">{stats.success}</p>
                    <p className="text-xs text-slate-500">Success</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-red-600">{stats.failure}</p>
                    <p className="text-xs text-slate-500">Failed</p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-slate-700">{stats.total}</p>
                    <p className="text-xs text-slate-500">Total</p>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Recent Webhook Logs */}
        {recentWebhooks.length > 0 && (
          <div className="bg-white border rounded-lg">
            <div className="p-4 border-b bg-slate-50">
              <h3 className="font-medium text-slate-900">Recent Webhook Events</h3>
            </div>
            <div className="divide-y">
              {recentWebhooks.map((wh) => (
                <div key={wh.id} className="p-3 flex items-center justify-between text-sm">
                  <div className="flex items-center gap-3">
                    <StatusBadge status={wh.status} />
                    <span className="font-mono text-slate-600">{wh.source}</span>
                    <span className="text-slate-500">{wh.eventType}</span>
                  </div>
                  <div className="flex items-center gap-3 text-slate-500">
                    <span>{wh.durationMs}ms</span>
                    <span>{formatDate(wh.createdAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
