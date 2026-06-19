"use client";

import { Clock } from "lucide-react";
import {
  StatusBadge,
  CronError,
  CronResultSummary,
  formatDate,
  formatOptionalDate,
} from "./shared";
import type { HealthData } from "./types";

export function BackgroundJobsSection({
  cronJobs,
  cronHealth,
}: {
  cronJobs: HealthData["cronJobs"];
  cronHealth: HealthData["cronHealth"];
}) {
  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900 mb-3 flex items-center gap-2">
        <Clock className="h-5 w-5" />
        Cron Jobs
      </h2>
      {(cronHealth
        ? cronHealth.jobs.length === 0
        : Object.keys(cronJobs).length === 0) ? (
        <div className="bg-white border rounded-lg p-4 text-slate-500">
          No cron job runs recorded yet.
        </div>
      ) : (
        <div className="space-y-4">
          {cronHealth?.jobs.map((job) => {
            const runs = cronJobs[job.jobName] ?? [];

            return (
              <div key={job.jobName} className="bg-white border rounded-lg">
                <div className="p-4 border-b bg-slate-50">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium text-slate-900">{job.label}</h3>
                        <span className="font-mono text-xs text-slate-500">
                          {job.jobName}
                        </span>
                      </div>
                      <p className="text-sm text-slate-600 mt-1">{job.summary}</p>
                    </div>
                    <StatusBadge status={job.status} />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3 text-sm">
                    <div>
                      <p className="text-xs text-slate-500">Schedule</p>
                      <p className="font-mono text-slate-700 break-words">
                        {job.schedule}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Expected</p>
                      <p className="text-slate-700">{job.expectedLocalTime}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Timezone</p>
                      <p className="text-slate-700">{job.timezone}</p>
                    </div>
                    <div>
                      <p className="text-xs text-slate-500">Stale threshold</p>
                      <p className="text-slate-700">
                        {job.staleThreshold ?? "Not tracked"}
                      </p>
                    </div>
                  </div>
                  {(job.disabledReason || job.note) && (
                    <div className="mt-3 text-sm text-slate-600 space-y-1">
                      {job.disabledReason && <p>{job.disabledReason}</p>}
                      {job.note && <p>{job.note}</p>}
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 text-xs text-slate-500">
                    <p>Latest run: {formatOptionalDate(job.latestRunAt)}</p>
                    <p>Latest success: {formatOptionalDate(job.latestSuccessAt)}</p>
                    <p>Latest failure: {formatOptionalDate(job.latestFailureAt)}</p>
                  </div>
                </div>
                <div className="divide-y">
                  {!job.recordsRuns ? (
                    <div className="p-3 text-sm text-slate-500">
                      CronJobRun history is not recorded for this scheduled job.
                    </div>
                  ) : runs.length === 0 ? (
                    <div className="p-3 text-sm text-slate-500">
                      No cron runs recorded yet.
                    </div>
                  ) : (
                    runs.map((run) => (
                      <div key={run.id} className="p-3 flex items-center justify-between text-sm">
                        <div className="flex items-center gap-3">
                          <StatusBadge status={run.status} />
                          <span className="text-slate-600">{formatDate(run.startedAt)}</span>
                        </div>
                        <div className="flex items-center gap-4 text-slate-500">
                          {run.durationMs != null && <span>{run.durationMs}ms</span>}
                          {run.error && <CronError error={run.error} />}
                          {run.resultSummary && <CronResultSummary summary={run.resultSummary} />}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            );
          }) ??
            Object.entries(cronJobs).map(([jobName, runs]) => (
              <div key={jobName} className="bg-white border rounded-lg">
                <div className="p-4 border-b bg-slate-50">
                  <h3 className="font-medium text-slate-900">{jobName}</h3>
                </div>
                <div className="divide-y">
                  {runs.map((run) => (
                    <div key={run.id} className="p-3 flex items-center justify-between text-sm">
                      <div className="flex items-center gap-3">
                        <StatusBadge status={run.status} />
                        <span className="text-slate-600">{formatDate(run.startedAt)}</span>
                      </div>
                      <div className="flex items-center gap-4 text-slate-500">
                        {run.durationMs != null && <span>{run.durationMs}ms</span>}
                        {run.error && <CronError error={run.error} />}
                        {run.resultSummary && <CronResultSummary summary={run.resultSummary} />}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
