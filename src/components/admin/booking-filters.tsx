"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { bookingFilterDateRangePresets } from "@/lib/date-range-presets";
import { bookingStatusLabel } from "@/lib/status-colors";

interface BookingFiltersProps {
  showBedAllocation?: boolean;
  // Active lodges for the lodge filter (multi-lodge phase 8). The control
  // only renders once a second lodge exists (ADR-002 presentation rule).
  lodgeOptions?: Array<{ id: string; name: string }>;
}

const KNOWN_BOOKING_FILTER_QUERY_KEYS = [
  "status",
  "lodgeId",
  "updatedFrom",
  "updatedTo",
  "checkInFrom",
  "checkInTo",
  "checkOutFrom",
  "checkOutTo",
  "from",
  "to",
  "search",
  "sort",
  "sortBy",
  "sortDir",
  "month",
  "deleted",
  "paymentSource",
  "xeroState",
  "bedState",
  "changeState",
  "page",
] as const;

export function BookingFilters({
  showBedAllocation = true,
  lodgeOptions = [],
}: BookingFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [updatedFrom, setUpdatedFrom] = useState(searchParams.get("updatedFrom") || "");
  const [updatedTo, setUpdatedTo] = useState(searchParams.get("updatedTo") || "");
  const [checkInFrom, setCheckInFrom] = useState(searchParams.get("checkInFrom") || searchParams.get("from") || "");
  const [checkInTo, setCheckInTo] = useState(searchParams.get("checkInTo") || searchParams.get("to") || "");
  const [checkOutFrom, setCheckOutFrom] = useState(searchParams.get("checkOutFrom") || "");
  const [checkOutTo, setCheckOutTo] = useState(searchParams.get("checkOutTo") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [month, setMonth] = useState(searchParams.get("month") || "all");
  const [deleted, setDeleted] = useState(searchParams.get("deleted") || "hide");
  const [paymentSource, setPaymentSource] = useState(searchParams.get("paymentSource") || "all");
  const [xeroState, setXeroState] = useState(searchParams.get("xeroState") || "all");
  const [bedState, setBedState] = useState(
    showBedAllocation ? searchParams.get("bedState") || "all" : "all"
  );
  const [changeState, setChangeState] = useState(searchParams.get("changeState") || "all");
  const [lodgeId, setLodgeId] = useState(searchParams.get("lodgeId") || "all");
  const showLodgeFilter = lodgeOptions.length > 1;
  const sortBy = searchParams.get("sortBy") || searchParams.get("sort") || "updatedAt";
  const sortDir = searchParams.get("sortDir") || "desc";
  const bookingStatuses = ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED", "CANCELLED", "BUMPED", "COMPLETED", "DRAFT"] as const;
  function statusFilterLabel(value: string) {
    if (value === "all") return "All";

    const statuses = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (statuses.length === 0) return "Custom status filter";
    return statuses.map((item) => bookingStatusLabel(item)).join(" + ");
  }

  const hasCustomStatusValue =
    status !== "all" &&
    !bookingStatuses.includes(status as (typeof bookingStatuses)[number]);

  // Generate month options: current year ±1
  const monthOptions: Array<{ value: string; label: string }> = [];
  const currentYear = new Date().getFullYear();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  for (let y = currentYear - 1; y <= currentYear + 1; y++) {
    for (let m = 0; m < 12; m++) {
      const val = `${y}-${String(m + 1).padStart(2, "0")}`;
      monthOptions.push({ value: val, label: `${monthNames[m]} ${y}` });
    }
  }

  // Filters apply automatically (debounced so typing in search doesn't push a
  // navigation per keystroke) while keeping the URL-driven server model:
  // filtered views stay shareable links.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      for (const key of KNOWN_BOOKING_FILTER_QUERY_KEYS) {
        params.delete(key);
      }
      if (status !== "all") params.set("status", status);
      if (updatedFrom) params.set("updatedFrom", updatedFrom);
      if (updatedTo) params.set("updatedTo", updatedTo);
      if (checkInFrom) params.set("checkInFrom", checkInFrom);
      if (checkInTo) params.set("checkInTo", checkInTo);
      if (checkOutFrom) params.set("checkOutFrom", checkOutFrom);
      if (checkOutTo) params.set("checkOutTo", checkOutTo);
      if (search) params.set("search", search);
      if (sortBy !== "updatedAt") params.set("sortBy", sortBy);
      if (sortDir !== "desc") params.set("sortDir", sortDir);
      if (month !== "all") params.set("month", month);
      if (deleted !== "hide") params.set("deleted", deleted);
      if (paymentSource !== "all") params.set("paymentSource", paymentSource);
      if (xeroState !== "all") params.set("xeroState", xeroState);
      if (showBedAllocation && bedState !== "all") params.set("bedState", bedState);
      if (changeState !== "all") params.set("changeState", changeState);
      if (showLodgeFilter && lodgeId !== "all") params.set("lodgeId", lodgeId);
      const next = params.toString();
      // Compare against the live URL so the initial render is a no-op.
      const current = new URLSearchParams(window.location.search);
      current.delete("page");
      if (next !== current.toString()) {
        router.push(next ? `/admin/bookings?${next}` : "/admin/bookings");
      }
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [status, updatedFrom, updatedTo, checkInFrom, checkInTo, checkOutFrom, checkOutTo, search, month, deleted, paymentSource, xeroState, bedState, changeState, sortBy, sortDir, showBedAllocation, lodgeId, showLodgeFilter, router]);

  function clearFilters() {
    setStatus("all");
    setUpdatedFrom("");
    setUpdatedTo("");
    setCheckInFrom("");
    setCheckInTo("");
    setCheckOutFrom("");
    setCheckOutTo("");
    setSearch("");
    setMonth("all");
    setDeleted("hide");
    setPaymentSource("all");
    setXeroState("all");
    setBedState("all");
    setChangeState("all");
    setLodgeId("all");
    router.push("/admin/bookings");
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Status</label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {hasCustomStatusValue ? (
              <SelectItem value={status}>{statusFilterLabel(status)}</SelectItem>
            ) : null}
            {bookingStatuses.map((bookingStatus) => (
              <SelectItem key={bookingStatus} value={bookingStatus}>
                {bookingStatusLabel(bookingStatus)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {showLodgeFilter && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-500">Lodge</label>
          <select
            value={lodgeId}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setLodgeId(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
          >
            <option value="all">All lodges</option>
            {lodgeOptions.map((lodge) => (
              <option key={lodge.id} value={lodge.id}>{lodge.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Month</label>
        <Select value={month} onValueChange={setMonth}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All months</SelectItem>
            {monthOptions.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Deleted</label>
        <Select value={deleted} onValueChange={setDeleted}>
          <SelectTrigger className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="hide">Hide deleted</SelectItem>
            <SelectItem value="include">Include deleted</SelectItem>
            <SelectItem value="only">Deleted only</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Payment</label>
        <Select value={paymentSource} onValueChange={setPaymentSource}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All payments</SelectItem>
            <SelectItem value="STRIPE">Stripe</SelectItem>
            <SelectItem value="INTERNET_BANKING">Internet Banking</SelectItem>
            <SelectItem value="NONE">No payment</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Xero</label>
        <Select value={xeroState} onValueChange={setXeroState}>
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Xero states</SelectItem>
            <SelectItem value="invoiceLinked">Invoice linked</SelectItem>
            <SelectItem value="invoiceMissing">Invoice missing</SelectItem>
            <SelectItem value="operationFailed">Failed activity</SelectItem>
            <SelectItem value="operationPartial">Partial activity</SelectItem>
            <SelectItem value="operationPending">Pending activity</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {showBedAllocation ? (
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-500">Beds</label>
          <Select value={bedState} onValueChange={setBedState}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All bed states</SelectItem>
              <SelectItem value="unallocated">Unallocated</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="complete">Complete</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Changes</label>
        <Select value={changeState} onValueChange={setChangeState}>
          <SelectTrigger className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All change states</SelectItem>
            <SelectItem value="requiresReview">Requires review</SelectItem>
            <SelectItem value="pendingRequest">Pending request</SelectItem>
            <SelectItem value="hasModification">Has modification</SelectItem>
            <SelectItem value="creditGenerated">Credit generated</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <DateRangeControls
        presets={bookingFilterDateRangePresets}
        from={updatedFrom}
        to={updatedTo}
        presetLabel="Updated Range"
        fromLabel="Updated From"
        toLabel="Updated To"
        idPrefix="bookings-updated"
        onFromChange={setUpdatedFrom}
        onToChange={setUpdatedTo}
      />
      <DateRangeControls
        presets={bookingFilterDateRangePresets}
        from={checkInFrom}
        to={checkInTo}
        presetLabel="Check In Range"
        fromLabel="Check In From"
        toLabel="Check In To"
        idPrefix="bookings-check-in"
        onFromChange={setCheckInFrom}
        onToChange={setCheckInTo}
      />
      <DateRangeControls
        presets={bookingFilterDateRangePresets}
        from={checkOutFrom}
        to={checkOutTo}
        presetLabel="Check Out Range"
        fromLabel="Check Out From"
        toLabel="Check Out To"
        idPrefix="bookings-check-out"
        onFromChange={setCheckOutFrom}
        onToChange={setCheckOutTo}
      />
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Search member</label>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or email..."
        />
      </div>
      <Button onClick={clearFilters} variant="outline" size="sm">
        Clear
      </Button>
    </div>
  );
}
