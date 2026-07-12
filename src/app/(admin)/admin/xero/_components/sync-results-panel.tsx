"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { SyncReportView } from "./shared"
import type { SyncResult } from "./types"

export function SyncResultsPanel({ syncResult, currentXeroPath }: { syncResult: SyncResult | null; currentXeroPath: string }) {
  if (!syncResult) return null
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Results</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          {syncResult.message ? <p>{syncResult.message}</p> : null}
          {syncResult.created !== undefined ? (
            <>
              <p>
                <span className="text-muted-foreground">New members created:</span>{" "}
                <span className="font-medium text-success">{syncResult.created}</span>
              </p>
              {syncResult.createdMembers && syncResult.createdMembers.length > 0 ? (
                <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                  {syncResult.createdMembers.map((member, index) => (
                    <li key={`${member.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span>{member.name}</span>
                      <span className="text-xs text-muted-foreground">{member.email}</span>
                      <Badge variant="outline" className="text-xs">{member.group}</Badge>
                      <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {syncResult.createdAsDependent !== undefined && syncResult.createdAsDependent > 0 ? (
                <div>
                  <p>
                    <span className="text-muted-foreground">Family dependents created:</span>{" "}
                    <span className="font-medium text-info">{syncResult.createdAsDependent}</span>
                  </p>
                  {syncResult.createdDependents && syncResult.createdDependents.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.createdDependents.map((member, index) => (
                        <li key={`${member.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{member.name}</span>
                          <span className="text-xs text-muted-foreground">{member.email}</span>
                          <Badge variant="outline" className="text-xs">{member.group}</Badge>
                          <span className="text-xs text-muted-foreground">Linked to {member.parentName}</span>
                          <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.skippedExisting !== undefined && syncResult.skippedExisting > 0 ? (
                <p><span className="text-muted-foreground">Skipped (already exist):</span> {syncResult.skippedExisting}</p>
              ) : null}
              {syncResult.linkedExisting !== undefined && syncResult.linkedExisting > 0 ? (
                <div>
                  <p><span className="text-muted-foreground">Existing members linked to Xero:</span> {syncResult.linkedExisting}</p>
                  {syncResult.linkedExistingDetails && syncResult.linkedExistingDetails.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.linkedExistingDetails.map((member, index) => (
                        <li key={`${member.memberId}-${member.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{member.name}</span>
                          <span className="text-xs text-muted-foreground">{member.email}</span>
                          <Badge variant="outline" className="text-xs">{member.group}</Badge>
                          <a href={`https://go.xero.com/Contacts/View/${member.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.skippedNoEmail !== undefined && syncResult.skippedNoEmail > 0 ? (
                <div>
                  <p><span className="text-muted-foreground">Skipped (no email):</span> {syncResult.skippedNoEmail}</p>
                  {syncResult.skippedNoEmailDetails && syncResult.skippedNoEmailDetails.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.skippedNoEmailDetails.map((contact, index) => (
                        <li key={`${contact.xeroContactId}-${index}`} className="flex items-center gap-2">
                          <span>{contact.name}</span>
                          <a href={`https://go.xero.com/Contacts/View/${contact.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.skippedArchived !== undefined && syncResult.skippedArchived > 0 ? (
                <div>
                  <p><span className="text-muted-foreground">Skipped (not active in Xero):</span> {syncResult.skippedArchived}</p>
                  {syncResult.skippedArchivedDetails && syncResult.skippedArchivedDetails.length > 0 ? (
                    <ul className="ml-4 mt-1 space-y-0.5 text-sm">
                      {syncResult.skippedArchivedDetails.map((contact, index) => (
                        <li key={`${contact.xeroContactId}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span>{contact.name}</span>
                          <Badge variant="outline" className="text-xs">{contact.group}</Badge>
                          {contact.reason ? <span className="text-xs text-muted-foreground">{contact.reason}</span> : null}
                          <a href={`https://go.xero.com/Contacts/View/${contact.xeroContactId}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Open in Xero</a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {syncResult.groupsProcessed && syncResult.groupsProcessed.length > 0 ? (
                <p><span className="text-muted-foreground">Groups processed:</span> {syncResult.groupsProcessed.join(", ")}</p>
              ) : null}
            </>
          ) : null}
          {syncResult.syncReport ? <SyncReportView report={syncResult.syncReport} returnTo={currentXeroPath} /> : null}
          {syncResult.checked !== undefined ? (
            <>
              <p><span className="text-muted-foreground">Members checked:</span> {syncResult.checked}</p>
              {syncResult.checked === 0 ? <p className="text-warning">No members with linked Xero contacts found. Use the setup tools below to import and link members first.</p> : null}
            </>
          ) : null}
          {syncResult.errors !== undefined && syncResult.errors > 0 ? (
            <div className="text-danger">
              <p><span className="text-muted-foreground">Errors:</span> {syncResult.errors}</p>
              {syncResult.errorDetails && syncResult.errorDetails.length > 0 ? (
                <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                  {syncResult.errorDetails.map((detail, index) => (
                    <li key={`${detail.member}-${index}`}><span className="font-medium">{detail.member}</span>: {detail.error}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}
