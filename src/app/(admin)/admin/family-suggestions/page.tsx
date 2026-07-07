"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useConfirm } from "@/components/confirm-dialog"

interface SuggestedMember {
  id: string
  firstName: string
  lastName: string
  email: string
  ageTier: string
  canLogin: boolean
  xeroContactId: string | null
}

interface Suggestion {
  signature: string
  suggestedName: string
  reason: string
  score: number
  members: SuggestedMember[]
}

interface SuggestionsData {
  suggestions: Suggestion[]
  ungroupedCount: number
  totalMembers: number
  hiddenCount: number
}

export default function FamilySuggestionsPage() {
  const [data, setData] = useState<SuggestionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [creating, setCreating] = useState<string | null>(null)
  const [hiding, setHiding] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)
  const [editNames, setEditNames] = useState<Record<string, string>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const [created, setCreated] = useState<Set<string>>(new Set())
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const { confirm, confirmDialog } = useConfirm()

  const fetchSuggestions = useCallback(async () => {
    setLoading(true)
    setError("")
    try {
      const res = await fetch("/api/admin/family-suggestions")
      if (!res.ok) throw new Error("Failed to fetch suggestions")
      const json = await res.json()
      setData(json)
      setDismissed(new Set())
      setCreated(new Set())
      setHidden(new Set())
      setEditNames({})
    } catch {
      setError("Failed to load suggestions")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSuggestions()
  }, [fetchSuggestions])

  async function handleCreate(suggestion: Suggestion) {
    const name = editNames[suggestion.signature] ?? suggestion.suggestedName
    const memberIds = suggestion.members.map((m) => m.id)

    setCreating(name)
    try {
      const res = await fetch("/api/admin/family-suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, memberIds }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to create group")
      setCreated((prev) => new Set(prev).add(suggestion.signature))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create group")
    } finally {
      setCreating(null)
    }
  }

  async function handleHide(suggestion: Suggestion) {
    const memberIds = suggestion.members.map((m) => m.id)

    setHiding(suggestion.signature)
    setError("")
    try {
      const res = await fetch("/api/admin/family-suggestions/hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberIds }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to hide suggestion")
      setHidden((prev) => new Set(prev).add(suggestion.signature))
      setData((prev) =>
        prev ? { ...prev, hiddenCount: prev.hiddenCount + 1 } : prev
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to hide suggestion")
    } finally {
      setHiding(null)
    }
  }

  async function handleResetHidden() {
    if (!data?.hiddenCount) return
    const confirmed = await confirm({
      title: "Reset hidden family suggestions?",
      description:
        "This will restore every permanently hidden family suggestion for all admins.",
      confirmLabel: "Reset hidden",
      destructive: true,
    })
    if (!confirmed) return

    setResetting(true)
    setError("")
    try {
      const res = await fetch("/api/admin/family-suggestions/reset", {
        method: "POST",
      })
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error || "Failed to reset hidden suggestions")
      }
      await fetchSuggestions()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset hidden suggestions")
    } finally {
      setResetting(false)
    }
  }

  const activeSuggestions = data?.suggestions.filter(
    (suggestion) =>
      !dismissed.has(suggestion.signature) &&
      !created.has(suggestion.signature) &&
      !hidden.has(suggestion.signature)
  ) ?? []

  return (
    <div className="space-y-6">
      {confirmDialog}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Family Group Suggestions</h1>
          <p className="text-muted-foreground mt-1">
            Review suggested family groups based on shared emails and last names among ungrouped members.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleResetHidden}
            disabled={loading || resetting || !data?.hiddenCount}
            variant="outline"
          >
            {resetting ? "Resetting..." : `Reset hidden (${data?.hiddenCount ?? 0})`}
          </Button>
          <Button onClick={fetchSuggestions} disabled={loading} variant="outline">
            {loading ? "Loading..." : "Refresh"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-3 text-red-800 text-sm">
          {error}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Members</CardDescription>
              <CardTitle className="text-2xl">{data.totalMembers}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Ungrouped Members</CardDescription>
              <CardTitle className="text-2xl">{data.ungroupedCount}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Suggestions</CardDescription>
              <CardTitle className="text-2xl">{activeSuggestions.length}</CardTitle>
            </CardHeader>
          </Card>
        </div>
      )}

      {loading && !data && (
        <div className="text-center py-12 text-muted-foreground">Loading suggestions...</div>
      )}

      {data && activeSuggestions.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No suggestions found. All members are already in family groups, or there are no patterns to suggest.
          </CardContent>
        </Card>
      )}

      {data?.suggestions.map((suggestion) => {
        if (
          dismissed.has(suggestion.signature) ||
          hidden.has(suggestion.signature)
        ) return null
        if (created.has(suggestion.signature)) {
          return (
            <Card key={suggestion.signature} className="border-green-200 bg-green-50">
              <CardContent className="py-4 text-center text-green-800">
                Family group &ldquo;{editNames[suggestion.signature] ?? suggestion.suggestedName}&rdquo; created successfully.
              </CardContent>
            </Card>
          )
        }

        return (
          <Card key={suggestion.signature}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Input
                    value={editNames[suggestion.signature] ?? suggestion.suggestedName}
                    onChange={(e) =>
                      setEditNames((prev) => ({
                        ...prev,
                        [suggestion.signature]: e.target.value,
                      }))
                    }
                    className="font-semibold text-lg w-64"
                  />
                  <Badge variant={suggestion.score >= 10 ? "default" : "secondary"}>
                    {suggestion.score >= 10 ? "High confidence" : "Medium confidence"}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setDismissed((prev) =>
                        new Set(prev).add(suggestion.signature)
                      )
                    }
                  >
                    Skip
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleHide(suggestion)}
                    disabled={hiding !== null}
                  >
                    {hiding === suggestion.signature ? "Hiding..." : "Permanently Hide"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => handleCreate(suggestion)}
                    disabled={creating !== null}
                  >
                    {creating === (editNames[suggestion.signature] ?? suggestion.suggestedName) ? "Creating..." : "Create Group"}
                  </Button>
                </div>
              </div>
              <CardDescription>{suggestion.reason}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="border rounded-md">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="text-left p-2 font-medium">Name</th>
                      <th className="text-left p-2 font-medium">Email</th>
                      <th className="text-left p-2 font-medium">Age Tier</th>
                      <th className="text-left p-2 font-medium">Can Login</th>
                      <th className="text-left p-2 font-medium">Xero</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suggestion.members.map((m) => (
                      <tr key={m.id} className="border-b last:border-0">
                        <td className="p-2">{m.firstName} {m.lastName}</td>
                        <td className="p-2 text-muted-foreground">{m.email}</td>
                        <td className="p-2">
                          <Badge variant="outline" className="text-xs">{m.ageTier}</Badge>
                        </td>
                        <td className="p-2">
                          {m.canLogin
                            ? <Badge className="bg-green-100 text-green-800 text-xs">Yes</Badge>
                            : <Badge variant="secondary" className="text-xs">No</Badge>}
                        </td>
                        <td className="p-2">
                          {m.xeroContactId
                            ? <Badge className="bg-blue-100 text-blue-800 text-xs">Linked</Badge>
                            : <span className="text-muted-foreground text-xs">-</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
