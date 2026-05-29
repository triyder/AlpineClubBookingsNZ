"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { BookingApprovalsPanel } from "@/components/admin/booking-requests/booking-approvals-panel";
import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";
import type { BookingRequestsTab } from "@/lib/admin-booking-requests-path";

const APPROVALS_SEARCH_PARAMS = { tab: "approvals" } satisfies Record<
  string,
  string
>;
const CHANGES_SEARCH_PARAMS = { tab: "changes" } satisfies Record<
  string,
  string
>;

function parseBookingRequestsTab(value: string | null): BookingRequestsTab {
  return value === "changes" ? "changes" : "approvals";
}

export default function BookingRequestsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = parseBookingRequestsTab(searchParams.get("tab"));

  function handleTabChange(value: string) {
    const nextTab = parseBookingRequestsTab(value);
    const params = new URLSearchParams(searchParams.toString());

    params.set("tab", nextTab);

    if (nextTab === "approvals") {
      params.delete("requestId");
      if (params.get("status") === "REQUESTED") {
        params.delete("status");
      }
    } else {
      params.delete("bookingId");
      if (params.get("status") === "PENDING") {
        params.delete("status");
      }
    }

    router.replace(`/admin/booking-requests?${params.toString()}`, {
      scroll: false,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Booking Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Review new booking approvals and locked-period booking change
          requests.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="grid w-full grid-cols-2 sm:w-auto">
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="changes">Changes</TabsTrigger>
        </TabsList>
        <TabsContent value="approvals" className="mt-6">
          {activeTab === "approvals" ? (
            <BookingApprovalsPanel
              fixedSearchParams={APPROVALS_SEARCH_PARAMS}
              showHeading={false}
            />
          ) : null}
        </TabsContent>
        <TabsContent value="changes" className="mt-6">
          {activeTab === "changes" ? (
            <BookingChangeRequestsPanel
              fixedSearchParams={CHANGES_SEARCH_PARAMS}
              showHeading={false}
            />
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
