"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { bookingFilterDateRangePresets } from "@/lib/date-range-presets";
import { bookingStatusLabel } from "@/lib/status-colors";

interface BookingFiltersProps {
  showBedAllocation?: boolean;
}

export function BookingFilters({ showBedAllocation = true }: BookingFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState(searchParams.get("status") || "all");
  const [updatedFrom, setUpdatedFrom] = useState(searchParams.get("updatedFrom") || "");
  const [updatedTo, setUpdatedTo] = useState(searchParams.get("updatedTo") || "");
  const [checkInFrom, setCheckInFrom] = useState(searchParams.get("checkInFrom") || searchParams.get("from") || "");
  const [checkInTo, setCheckInTo] = useState(searchParams.get("checkInTo") || searchParams.get("to") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [month, setMonth] = useState(searchParams.get("month") || "");
  const [deleted, setDeleted] = useState(searchParams.get("deleted") || "hide");
  const [paymentSource, setPaymentSource] = useState(searchParams.get("paymentSource") || "all");
  const [xeroState, setXeroState] = useState(searchParams.get("xeroState") || "all");
  const [bedState, setBedState] = useState(
    showBedAllocation ? searchParams.get("bedState") || "all" : "all"
  );
  const [changeState, setChangeState] = useState(searchParams.get("changeState") || "all");
  const sortBy = searchParams.get("sortBy") || searchParams.get("sort") || "updatedAt";
  const sortDir = searchParams.get("sortDir") || "desc";
  const bookingStatuses = ["PAYMENT_PENDING", "CONFIRMED", "PAID", "PENDING", "WAITLISTED", "WAITLIST_OFFERED", "CANCELLED", "BUMPED", "COMPLETED", "DRAFT"] as const;

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

  function applyFilters() {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    if (updatedFrom) params.set("updatedFrom", updatedFrom);
    if (updatedTo) params.set("updatedTo", updatedTo);
    if (checkInFrom) params.set("checkInFrom", checkInFrom);
    if (checkInTo) params.set("checkInTo", checkInTo);
    if (search) params.set("search", search);
    if (sortBy !== "updatedAt") params.set("sortBy", sortBy);
    if (sortDir !== "desc") params.set("sortDir", sortDir);
    if (month) params.set("month", month);
    if (deleted !== "hide") params.set("deleted", deleted);
    if (paymentSource !== "all") params.set("paymentSource", paymentSource);
    if (xeroState !== "all") params.set("xeroState", xeroState);
    if (showBedAllocation && bedState !== "all") params.set("bedState", bedState);
    if (changeState !== "all") params.set("changeState", changeState);
    router.push(`/admin/bookings?${params.toString()}`);
  }

  function clearFilters() {
    setStatus("all");
    setUpdatedFrom("");
    setUpdatedTo("");
    setCheckInFrom("");
    setCheckInTo("");
    setSearch("");
    setMonth("");
    setDeleted("hide");
    setPaymentSource("all");
    setXeroState("all");
    setBedState("all");
    setChangeState("all");
    router.push("/admin/bookings");
  }

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-white p-4">
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Status</label>
        <select
          value={status}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setStatus(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="all">All</option>
          {bookingStatuses.map((bookingStatus) => (
            <option key={bookingStatus} value={bookingStatus}>
              {bookingStatusLabel(bookingStatus)}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Month</label>
        <select
          value={month}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setMonth(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="">All months</option>
          {monthOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Deleted</label>
        <select
          value={deleted}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setDeleted(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="hide">Hide deleted</option>
          <option value="include">Include deleted</option>
          <option value="only">Deleted only</option>
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Payment</label>
        <select
          value={paymentSource}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setPaymentSource(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="all">All payments</option>
          <option value="STRIPE">Stripe</option>
          <option value="INTERNET_BANKING">Internet Banking</option>
          <option value="NONE">No payment</option>
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Xero</label>
        <select
          value={xeroState}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setXeroState(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="all">All Xero states</option>
          <option value="invoiceLinked">Invoice linked</option>
          <option value="invoiceMissing">Invoice missing</option>
          <option value="operationFailed">Failed activity</option>
          <option value="operationPartial">Partial activity</option>
          <option value="operationPending">Pending activity</option>
        </select>
      </div>
      {showBedAllocation ? (
        <div className="space-y-1">
          <label className="text-xs font-medium text-gray-500">Beds</label>
          <select
            value={bedState}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setBedState(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
          >
            <option value="all">All bed states</option>
            <option value="unallocated">Unallocated</option>
            <option value="partial">Partial</option>
            <option value="complete">Complete</option>
            <option value="warning">Warning</option>
          </select>
        </div>
      ) : null}
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Changes</label>
        <select
          value={changeState}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setChangeState(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
        >
          <option value="all">All change states</option>
          <option value="requiresReview">Requires review</option>
          <option value="pendingRequest">Pending request</option>
          <option value="hasModification">Has modification</option>
          <option value="creditGenerated">Credit generated</option>
        </select>
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
      <div className="space-y-1">
        <label className="text-xs font-medium text-gray-500">Search member</label>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Name or email..."
        />
      </div>
      <Button onClick={applyFilters} size="sm">
        Filter
      </Button>
      <Button onClick={clearFilters} variant="outline" size="sm">
        Clear
      </Button>
    </div>
  );
}
