"use client";

import { BookingCalendar } from "@/components/booking-calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function DatesStep({
  subscriptionUnpaid,
  handleDateSelect,
  checkIn,
  checkOut,
}: {
  subscriptionUnpaid: boolean | null;
  handleDateSelect: (ci: Date, co: Date) => void;
  checkIn: Date | null;
  checkOut: Date | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Select Your Dates</CardTitle>
      </CardHeader>
      <CardContent>
        {subscriptionUnpaid ? (
          <p className="text-sm text-amber-700 py-8 text-center">
            Booking is disabled until your subscription is paid.
          </p>
        ) : (
          <BookingCalendar
            onDateSelect={handleDateSelect}
            selectedCheckIn={checkIn}
            selectedCheckOut={checkOut}
          />
        )}
      </CardContent>
    </Card>
  );
}
