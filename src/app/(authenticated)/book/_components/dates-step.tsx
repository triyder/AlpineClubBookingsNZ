"use client";

import { BookingCalendar } from "@/components/booking-calendar";
import { LodgeSelect, type LodgeOption } from "@/components/lodge-select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DatesStep({
  subscriptionUnpaid,
  handleDateSelect,
  checkIn,
  checkOut,
  lodges,
  lodgeId,
  lodgesLoading,
  handleLodgeChange,
  selectedLodge,
}: {
  subscriptionUnpaid: boolean | null;
  handleDateSelect: (ci: Date, co: Date) => void;
  checkIn: Date | null;
  checkOut: Date | null;
  lodges: LodgeOption[];
  lodgeId: string | null;
  lodgesLoading: boolean;
  handleLodgeChange: (nextLodgeId: string | null) => void;
  selectedLodge: LodgeOption | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Your Dates</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {subscriptionUnpaid ? (
          <p className="text-sm text-amber-700 py-8 text-center">
            Booking is disabled until your subscription is paid.
          </p>
        ) : (
          <>
            <div className="max-w-xs">
              <LodgeSelect
                lodges={lodges}
                value={lodgeId}
                onChange={handleLodgeChange}
                loading={lodgesLoading}
              />
            </div>
            {lodges.length > 1 && selectedLodge?.travelNote ? (
              <p className="text-sm text-muted-foreground">
                {selectedLodge.travelNote}
              </p>
            ) : null}
            <BookingCalendar
              onDateSelect={handleDateSelect}
              selectedCheckIn={checkIn}
              selectedCheckOut={checkOut}
              lodgeId={lodgeId}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
