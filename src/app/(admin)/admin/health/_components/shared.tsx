"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

export function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ok: "bg-green-100 text-green-800",
    healthy: "bg-green-100 text-green-800",
    SUCCESS: "bg-green-100 text-green-800",
    success: "bg-green-100 text-green-800",
    current: "bg-green-100 text-green-800",
    degraded: "bg-yellow-100 text-yellow-800",
    SKIPPED: "bg-yellow-100 text-yellow-800",
    skipped: "bg-yellow-100 text-yellow-800",
    stale: "bg-yellow-100 text-yellow-800",
    missing: "bg-yellow-100 text-yellow-800",
    error: "bg-red-100 text-red-800",
    unhealthy: "bg-red-100 text-red-800",
    FAILURE: "bg-red-100 text-red-800",
    failure: "bg-red-100 text-red-800",
    failed: "bg-red-100 text-red-800",
    BOUNCE: "bg-red-100 text-red-800",
    COMPLAINT: "bg-red-100 text-red-800",
    disabled: "bg-muted text-muted-foreground",
    untracked: "bg-muted text-muted-foreground",
    unknown: "bg-muted text-foreground",
  };

  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colors[status] || colors.unknown}`}
    >
      {status}
    </span>
  );
}

export function StatusIcon({ status }: { status: string }) {
  if (status === "ok" || status === "healthy" || status === "SUCCESS" || status === "success") {
    return <CheckCircle className="h-5 w-5 text-green-500" />;
  }
  if (status === "degraded" || status === "SKIPPED") {
    return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
  }
  return <XCircle className="h-5 w-5 text-red-500" />;
}

export function formatUptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString(APP_LOCALE, {
    timeZone: APP_TIME_ZONE,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatOptionalDate(dateStr: string | null) {
  return dateStr ? formatDate(dateStr) : "Not recorded";
}

export function CronError({ error }: { error: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = error.length > 80;

  if (!isLong) {
    return <span className="text-red-600">{error}</span>;
  }

  return (
    <button
      onClick={() => setExpanded((e) => !e)}
      className="text-left text-red-600 max-w-xs"
    >
      {expanded ? (
        <span className="whitespace-pre-wrap break-words">{error}</span>
      ) : (
        <span>{error.slice(0, 80)}... <span className="text-red-400 underline text-xs">show more</span></span>
      )}
    </button>
  );
}

export function CronResultSummary({ summary }: { summary: Record<string, unknown> }) {
  const healthSignal = typeof summary.healthSignal === "string" ? summary.healthSignal : null;
  const sizeBytes = typeof summary.sizeBytes === "number" ? summary.sizeBytes : null;
  const minSizeBytes = typeof summary.minSizeBytes === "number" ? summary.minSizeBytes : null;
  const reason = typeof summary.reason === "string" ? summary.reason : null;

  if (healthSignal || sizeBytes !== null) {
    return (
      <span className="text-xs text-muted-foreground">
        {healthSignal ? `${healthSignal}` : "backup"}{" "}
        {sizeBytes !== null ? `${sizeBytes} bytes` : ""}
        {minSizeBytes !== null ? ` / min ${minSizeBytes}` : ""}
      </span>
    );
  }

  if (reason) {
    return <span className="text-xs text-muted-foreground">{reason}</span>;
  }

  return null;
}
