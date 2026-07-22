"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ClubIdentity } from "@/config/club-identity-types";
import { formatNZDate } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";

type Outcome =
  | "idle"
  | "submitting"
  | "created"
  | "already_done"
  | "invalid"
  | "expired"
  | "not_joinable"
  | "capacity_full"
  | "error";

interface CreatedDetails {
  payToken?: string;
  priceCents?: number;
  checkIn?: string;
  checkOut?: string;
  guestCount?: number;
}

export function GroupJoinVerifyPageClient({
  club,
  token,
}: {
  club: ClubIdentity;
  token: string;
}) {
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [details, setDetails] = useState<CreatedDetails>({});
  const [message, setMessage] = useState<string>("");

  async function confirm() {
    setOutcome("submitting");
    setMessage("");
    try {
      const res = await fetch(
        `/api/group-bookings/join/verify/${encodeURIComponent(token)}`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({}));

      if (res.status === 404) return setOutcome("invalid");
      if (res.status === 410) return setOutcome("expired");
      if (res.status === 409) {
        setMessage(data.message || "");
        return setOutcome(data.outcome === "capacity_full" ? "capacity_full" : "not_joinable");
      }
      if (!res.ok) return setOutcome("error");

      if (data.outcome === "already_done") {
        return setOutcome("already_done");
      }
      if (data.outcome === "created") {
        setDetails({
          payToken: data.payToken,
          priceCents: data.priceCents,
          checkIn: data.checkIn,
          checkOut: data.checkOut,
          guestCount: data.guestCount,
        });
        setOutcome("created");
        // Hand straight off to the existing pay-by-link page.
        if (data.payToken) {
          window.location.href = `/pay/${encodeURIComponent(data.payToken)}`;
        }
        return;
      }
      setOutcome("error");
    } catch {
      setOutcome("error");
    }
  }

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-lg items-center justify-center p-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Confirm your group booking spot</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {outcome === "idle" || outcome === "submitting" ? (
            <>
              <p className="text-sm text-muted-foreground">
                Confirm your email to finalise your spot at {club.lodgeName}. We&apos;ll
                then take you to a secure page to pay for your stay.
              </p>
              <Button onClick={confirm} disabled={outcome === "submitting"}>
                {outcome === "submitting" ? "Confirming..." : "Confirm and continue to payment"}
              </Button>
            </>
          ) : null}

          {outcome === "created" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-success-11">
                <CheckCircle2 className="h-6 w-6 shrink-0" />
                <p className="font-medium">Your spot is reserved — taking you to payment...</p>
              </div>
              {details.checkIn && details.checkOut ? (
                <div className="rounded-md border bg-card p-3 text-sm text-muted-foreground">
                  <p>
                    Dates: {formatNZDate(new Date(details.checkIn))} to{" "}
                    {formatNZDate(new Date(details.checkOut))}
                  </p>
                  {typeof details.guestCount === "number" ? (
                    <p className="mt-1">Guests: {details.guestCount}</p>
                  ) : null}
                  {typeof details.priceCents === "number" ? (
                    <p className="mt-1 font-semibold text-foreground">
                      Amount due: {formatCents(details.priceCents)}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {details.payToken ? (
                <p className="text-sm text-muted-foreground">
                  If you are not redirected,{" "}
                  <a className="underline" href={`/pay/${encodeURIComponent(details.payToken)}`}>
                    continue to payment
                  </a>
                  .
                </p>
              ) : null}
            </div>
          ) : null}

          {outcome === "already_done" ? (
            <div className="flex items-start gap-2 text-success-11">
              <CheckCircle2 className="h-6 w-6 shrink-0" />
              <p className="font-medium">
                You&apos;re already confirmed for this group booking. Check your email for the
                payment link.
              </p>
            </div>
          ) : null}

          {outcome === "expired" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-warning-11">
                <Clock className="h-6 w-6 shrink-0" />
                <p className="font-medium">This confirmation link has expired.</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Confirmation links are valid for 48 hours. Ask the organiser for a fresh link, or
                submit a new request to join.
              </p>
            </div>
          ) : null}

          {outcome === "capacity_full" ? (
            <div className="flex items-start gap-2 text-warning-11">
              <AlertTriangle className="h-6 w-6 shrink-0" />
              <p className="font-medium">
                The lodge has filled up for these dates, so this spot is no longer available.
              </p>
            </div>
          ) : null}

          {outcome === "not_joinable" ? (
            <div className="flex items-start gap-2 text-warning-11">
              <AlertTriangle className="h-6 w-6 shrink-0" />
              <p className="font-medium">
                {message || "This group is no longer accepting joins."}
              </p>
            </div>
          ) : null}

          {outcome === "invalid" || outcome === "error" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-warning-11">
                <AlertTriangle className="h-6 w-6 shrink-0" />
                <p className="font-medium">This confirmation link is not valid.</p>
              </div>
              <p className="text-sm text-muted-foreground">
                Please check you used the most recent link from your email, or contact{" "}
                {club.name} for help.
              </p>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
