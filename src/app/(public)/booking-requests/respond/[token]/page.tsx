"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatNZDate, formatNZDateTime } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";

interface QuoteOption {
  id: string;
  label: string;
  cateringOption: "CATERED" | "NON_CATERED" | null;
  totalCents: number;
  guestBreakdown: Array<{
    guestIndex: number;
    firstName: string;
    lastName: string;
    ageTier: string;
    isMember: boolean;
    nightCount: number;
    rateCents: number | null;
    totalCents: number;
  }>;
}

interface QuoteContext {
  requestId: string;
  quoteId: string;
  version: number;
  type: "GENERAL" | "SCHOOL";
  schoolName: string | null;
  contactFirstName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  message: string | null;
  expiresAt: string;
  options: QuoteOption[];
}

type LoadState = "loading" | "ready" | "invalid" | "expired" | "error";
type Action = "ACCEPT" | "CANCEL" | "MODIFY" | "QUERY";

export default function BookingRequestQuoteResponsePage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>("loading");
  const [context, setContext] = useState<QuoteContext | null>(null);
  // Sampled when the quote context arrives so the expiry label below can be
  // derived without calling Date.now() mid-render.
  const [contextLoadedAt, setContextLoadedAt] = useState<number | null>(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [actioning, setActioning] = useState<Action | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/booking-requests/respond/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 410) {
          setState("expired");
        } else if (res.status === 404) {
          setState("invalid");
        } else if (res.ok) {
          setContext(data);
          setContextLoadedAt(Date.now());
          setSelectedOptionId(data.options?.[0]?.id ?? null);
          setState("ready");
        } else {
          setError(data.error || "Unable to load this quote.");
          setState("error");
        }
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  const selectedOption = useMemo(
    () => context?.options.find((option) => option.id === selectedOptionId) ?? null,
    [context, selectedOptionId],
  );

  const expiresInLabel = useMemo(() => {
    if (!context || contextLoadedAt === null) return null;
    const remainingMs = new Date(context.expiresAt).getTime() - contextLoadedAt;
    if (remainingMs <= 0) return "expired";
    const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
    return days <= 1 ? "expires today" : `expires in ${days} days`;
  }, [context, contextLoadedAt]);

  async function respond(action: Action) {
    setActioning(action);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(`/api/booking-requests/respond/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          optionId: selectedOptionId,
          message: message.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to send your response.");
      }
      if (data.outcome === "accepted") {
        setResult("Quote accepted. We have sent the next steps by email.");
      } else if (data.outcome === "cancelled") {
        setResult("Quote cancelled. We have let the booking team know.");
      } else if (data.outcome === "modification_requested") {
        setResult("Change request sent. The booking team will review it and send a new quote.");
      } else {
        setResult("Question sent. The booking team will reply or send an updated quote.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to send your response.");
    } finally {
      setActioning(null);
    }
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Booking Quote</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {state === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading quote...</p>
        ) : state === "invalid" ? (
          <div className="flex gap-3 text-amber-800">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">This quote link is not valid.</p>
              <p className="text-sm text-muted-foreground">
                Please check the most recent quote email or contact the club.
              </p>
            </div>
          </div>
        ) : state === "expired" ? (
          <div className="flex gap-3 text-amber-800">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">This quote has expired.</p>
              <p className="text-sm text-muted-foreground">
                Quotes are only valid for a limited time. Please contact the club
                to ask for an updated quote, and we will send you a fresh link.
              </p>
            </div>
          </div>
        ) : state === "error" || !context ? (
          <div className="flex gap-3 text-amber-800">
            <HelpCircle className="mt-0.5 h-5 w-5 shrink-0" />
            <p>{error || "Unable to load this quote right now."}</p>
          </div>
        ) : result ? (
          <div className="flex gap-3 text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
            <p className="font-medium">{result}</p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 rounded-md border bg-slate-50 p-3 text-sm sm:grid-cols-2">
              {context.type === "SCHOOL" && context.schoolName ? (
                <p>
                  <span className="text-muted-foreground">School:</span>{" "}
                  {context.schoolName}
                </p>
              ) : null}
              <p>
                <span className="text-muted-foreground">Dates:</span>{" "}
                {formatNZDate(new Date(context.checkIn))} to{" "}
                {formatNZDate(new Date(context.checkOut))}
              </p>
              <p>
                <span className="text-muted-foreground">Guests:</span>{" "}
                {context.guestCount}
              </p>
              <p>
                <span className="text-muted-foreground">Expires:</span>{" "}
                {formatNZDateTime(new Date(context.expiresAt))}
                {expiresInLabel ? (
                  <span className="text-muted-foreground"> ({expiresInLabel})</span>
                ) : null}
              </p>
            </div>

            {context.message ? (
              <div className="rounded-md border bg-white p-3 text-sm text-slate-700">
                {context.message}
              </div>
            ) : null}

            <div className="space-y-3">
              <p className="text-sm font-medium">Options</p>
              {context.options.map((option) => (
                <label
                  key={option.id}
                  className={`block cursor-pointer rounded-md border p-3 ${
                    selectedOptionId === option.id
                      ? "border-primary bg-primary/5"
                      : "border-slate-200"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="quote-option"
                      value={option.id}
                      checked={selectedOptionId === option.id}
                      onChange={() => setSelectedOptionId(option.id)}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium">{option.label}</p>
                        <Badge variant="secondary">{formatCents(option.totalCents)}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {option.guestBreakdown.map((guest) => (
                          <Badge key={guest.guestIndex} variant="outline">
                            {guest.firstName} {guest.lastName}:{" "}
                            {formatCents(guest.totalCents)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <Label htmlFor="quote-message">Message</Label>
              <Textarea
                id="quote-message"
                maxLength={2000}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="Add a note if you are asking a question or requesting a change"
              />
            </div>

            {error ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => respond("ACCEPT")}
                disabled={!selectedOption || Boolean(actioning)}
              >
                Accept Quote
              </Button>
              <Button
                variant="outline"
                onClick={() => respond("QUERY")}
                disabled={Boolean(actioning)}
              >
                Send Question
              </Button>
              <Button
                variant="outline"
                onClick={() => respond("MODIFY")}
                disabled={Boolean(actioning)}
              >
                Request Changes
              </Button>
              <Button
                variant="destructive"
                onClick={() => respond("CANCEL")}
                disabled={Boolean(actioning)}
              >
                Cancel Request
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
