"use client"

import { useCallback, useEffect, useState } from "react"
import { SECTION_DEFAULTS, SECTION_STORAGE_KEY, type SectionKey, type XeroStatus } from "../_components/types"

export function useXeroConnection() {
  const [status, setStatus] = useState<XeroStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [connectSuccess, setConnectSuccess] = useState(false)
  const [sectionOpen, setSectionOpen] = useState<Record<SectionKey, boolean>>(SECTION_DEFAULTS)
  const [sectionsHydrated, setSectionsHydrated] = useState(false)

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/xero/status")
      if (!res.ok) throw new Error("Failed to fetch status")
      const data: XeroStatus = await res.json()
      setStatus(data)
    } catch {
      setError("Failed to load Xero connection status")
    } finally {
      setLoading(false)
    }
  }, [])

  const setSectionState = useCallback((section: SectionKey, nextOpen: boolean) => {
    setSectionOpen((prev) => ({ ...prev, [section]: nextOpen }))
  }, [])

  const scrollToSection = useCallback((section: SectionKey) => {
    setSectionOpen((prev) => ({ ...prev, [section]: true }))
    window.setTimeout(() => {
      document.getElementById(`xero-section-${section}`)?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, 0)
  }, [])

  const handleConnect = useCallback(() => {
    window.location.href = "/api/admin/xero/connect"
  }, [])

  const handleDisconnect = useCallback(async () => {
    if (!confirm("Are you sure you want to disconnect Xero? This will remove all stored tokens.")) return
    try {
      const res = await fetch("/api/admin/xero/disconnect", { method: "POST" })
      if (!res.ok) throw new Error("Failed to disconnect")
      setStatus({ connected: false, needsReentry: false, tenantId: null, tokenExpiresAt: null })
    } catch {
      setError("Failed to disconnect Xero")
    }
  }, [])

  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus])

  useEffect(() => {
    try {
      const storedState = window.localStorage.getItem(SECTION_STORAGE_KEY)
      if (storedState) {
        setSectionOpen((prev) => ({
          ...prev,
          ...(JSON.parse(storedState) as Partial<Record<SectionKey, boolean>>),
        }))
      }
    } catch {
      // Ignore malformed localStorage state and fall back to defaults.
    } finally {
      setSectionsHydrated(true)
    }
  }, [])

  useEffect(() => {
    if (sectionsHydrated) window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(sectionOpen))
  }, [sectionOpen, sectionsHydrated])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("connected") === "true") {
      setConnectSuccess(true)
      void fetchStatus()
    }
    const errorParam = params.get("error")
    if (errorParam) setError(decodeURIComponent(errorParam))
  }, [fetchStatus])

  return {
    status,
    loading,
    error,
    setError,
    connectSuccess,
    setConnectSuccess,
    sectionOpen,
    setSectionState,
    scrollToSection,
    handleConnect,
    handleDisconnect,
  }
}
