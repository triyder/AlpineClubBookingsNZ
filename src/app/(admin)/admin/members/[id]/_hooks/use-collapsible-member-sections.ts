"use client"

import { useEffect, useState } from "react"
import {
  collapsibleMemberSections,
  isCollapsibleMemberSection,
  memberSectionStorageKeys,
  type CollapsibleMemberSection,
} from "@/lib/admin-member-detail-helpers"

export function useCollapsibleMemberSections() {
  const [openSections, setOpenSections] = useState<CollapsibleMemberSection[]>(
    []
  )

  useEffect(() => {
    try {
      setOpenSections(
        collapsibleMemberSections.filter((section) => {
          const storedValue = window.localStorage.getItem(
            memberSectionStorageKeys[section]
          )
          return storedValue === "true" || storedValue === "open"
        })
      )
    } catch {
      // localStorage unavailable; sections stay collapsed for this visit.
    }
  }, [])

  const onValueChange = (value: string[]) => {
    const nextSections = value.filter(isCollapsibleMemberSection)
    setOpenSections(nextSections)

    try {
      collapsibleMemberSections.forEach((section) => {
        window.localStorage.setItem(
          memberSectionStorageKeys[section],
          String(nextSections.includes(section))
        )
      })
    } catch {
      // Ignore storage failures; the accordion still works for this visit.
    }
  }

  return { openSections, onValueChange }
}
