import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSchoolAttendeeConfirmation } from "@/lib/school-attendee-confirmation";
import { formatNZDate } from "@/lib/nzst-date";
import { SchoolAttendeeConfirmForm } from "./school-attendee-confirm-form";

/**
 * Public school attendee confirmation page (#1101). Reached from the tokenized
 * email link; lets the school contact replace placeholder attendee names
 * (identity-only, price-preserving) and explicitly confirm the list.
 */
export default async function SchoolAttendeeConfirmationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const details = await getSchoolAttendeeConfirmation(token);

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Confirm Your Attendee List</CardTitle>
        {details.request?.schoolName ? (
          <CardDescription>{details.request.schoolName}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-6">
        {details.booking ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Check-in
              </p>
              <p className="mt-1 text-sm">
                {formatNZDate(new Date(details.booking.checkIn))}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Check-out
              </p>
              <p className="mt-1 text-sm">
                {formatNZDate(new Date(details.booking.checkOut))}
              </p>
            </div>
          </div>
        ) : null}

        {details.status !== "ready" ? (
          <div
            className={`rounded-md border px-4 py-3 text-sm ${
              details.status === "confirmed"
                ? "border-success-6 bg-success-3 text-success-11"
                : "border-warning-6 bg-warning-3 text-warning-11"
            }`}
          >
            {details.message}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{details.message}</p>
        )}

        {details.booking && details.status === "ready" ? (
          <SchoolAttendeeConfirmForm
            token={token}
            guests={details.booking.guests}
          />
        ) : details.booking && details.status === "confirmed" ? (
          <div className="divide-y divide-border rounded-md border border-border">
            {details.booking.guests.map((guest) => (
              <div className="flex items-center justify-between p-3 text-sm" key={guest.id}>
                <span className="font-medium">
                  {guest.firstName} {guest.lastName}
                </span>
                <span className="text-xs text-muted-foreground">{guest.ageTier}</span>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
