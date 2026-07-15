"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import StripeProvider from "@/components/stripe/StripeProvider";
import PaymentForm from "@/components/stripe/PaymentForm";
import { useClubIdentity } from "@/components/club-identity-provider";
import { formatNZDate } from "@/lib/nzst-date";
import { formatCents } from "@/lib/utils";

interface Narrative {
  state: string;
  headline: string;
  message: string;
  nextStep: string;
}

interface PaymentLinkContext {
  state: string;
  narrative: Narrative;
  firstName: string;
  payable: {
    checkIn: string;
    checkOut: string;
    guestCount: number;
    status: string;
    amountCents: number;
    internetBankingReference?: string;
    expiresAt: string;
  } | null;
  canRequestFreshLink: boolean;
}

type Tone = "success" | "warning" | "info";

const TONE_STYLES: Record<Tone, { wrap: string; icon: typeof Info }> = {
  success: { wrap: "text-emerald-700", icon: CheckCircle2 },
  warning: { wrap: "text-amber-700", icon: AlertTriangle },
  info: { wrap: "text-sky-700", icon: Info },
};

function toneForState(state: string): Tone {
  if (state === "paid") return "success";
  if (
    state === "cancelled_post_payment" ||
    state === "cancelled_pre_payment" ||
    state === "declined"
  ) {
    return "warning";
  }
  return "info";
}

function NarrativeCard({
  narrative,
  tone,
  children,
}: {
  narrative: Narrative;
  tone: Tone;
  children?: React.ReactNode;
}) {
  const { wrap, icon: Icon } = TONE_STYLES[tone];
  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>{narrative.headline}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className={`flex items-start gap-2 ${wrap}`}>
          <Icon className="h-6 w-6 shrink-0" />
          <p className="font-medium">{narrative.message}</p>
        </div>
        <p className="text-sm text-muted-foreground">{narrative.nextStep}</p>
        {children}
      </CardContent>
    </Card>
  );
}

export default function PayByLinkPage() {
  const club = useClubIdentity();
  const { token } = useParams<{ token: string }>();
  const [context, setContext] = useState<PaymentLinkContext | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [intentError, setIntentError] = useState<string | null>(null);
  const [intentLoading, setIntentLoading] = useState(false);
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [refreshState, setRefreshState] = useState<"idle" | "sending" | "sent">(
    "idle"
  );
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [bookingMessages, setBookingMessages] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/pay/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(data.error || "This payment link is not valid.");
        } else {
          setContext(data);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError("Unable to load this payment link right now.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    fetch("/api/booking-messages")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setBookingMessages(data?.messages ?? {}))
      .catch(() => setBookingMessages({}));
  }, []);

  async function startCardPayment() {
    setIntentLoading(true);
    setIntentError(null);
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/payment-intent`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to start payment");
      }
      if (data.alreadyPaid) {
        setPaymentComplete(true);
        return;
      }
      setClientSecret(data.clientSecret);
    } catch (err) {
      setIntentError(err instanceof Error ? err.message : "Unable to start payment");
    } finally {
      setIntentLoading(false);
    }
  }

  async function requestFreshLink() {
    setRefreshState("sending");
    setRefreshError(null);
    try {
      const res = await fetch(`/api/pay/${encodeURIComponent(token)}/refresh`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to send a new link right now.");
      }
      if (data.emailed === false) {
        // The link was re-issued but the email was suppressed (this address
        // previously bounced or complained), so nothing will arrive (#1885).
        // Never claim an email is on the way.
        setRefreshState("idle");
        setRefreshError(
          `We weren't able to send email to this address. Please contact ${club.lodgeName} and we'll help you complete payment.`
        );
        return;
      }
      setRefreshState("sent");
    } catch (err) {
      setRefreshState("idle");
      setRefreshError(
        err instanceof Error ? err.message : "Unable to send a new link right now."
      );
    }
  }

  if (loading) {
    return (
      <Card className="w-full max-w-lg">
        <CardContent className="py-8 text-center text-muted-foreground">Loading...</CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Payment Link</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-2 text-amber-700">
            <AlertTriangle className="h-6 w-6 shrink-0" />
            <p className="font-medium">{loadError}</p>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Please check you copied the whole link from your email. If it still
            doesn&apos;t work, contact {club.lodgeName} and we&apos;ll send a fresh one.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!context) return null;

  // A completed card payment lands here before the page is re-fetched.
  if (paymentComplete || context.state === "paid") {
    const narrative: Narrative =
      context.state === "paid"
        ? context.narrative
        : {
            state: "paid",
            headline: "Payment received",
            message: `Thanks ${context.firstName} — your payment is complete.`,
            nextStep: `Your booking with ${club.lodgeName} is confirmed. We look forward to seeing you.`,
          };
    return <NarrativeCard narrative={narrative} tone="success" />;
  }

  if (context.state === "expired_payable") {
    return (
      <NarrativeCard narrative={context.narrative} tone="info">
        {refreshState === "sent" ? (
          <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            <CheckCircle2 className="h-5 w-5 shrink-0" />
            <p>We&apos;ve emailed you a fresh payment link. Please check your inbox.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Button onClick={requestFreshLink} disabled={refreshState === "sending"}>
              {refreshState === "sending" ? "Sending..." : "Email me a new link"}
            </Button>
            {refreshError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {refreshError}
              </div>
            ) : null}
          </div>
        )}
      </NarrativeCard>
    );
  }

  if (context.state !== "payable" || !context.payable) {
    // bumped / cancelled / declined / under_review / unknown — a clear,
    // specific message with a concrete next step.
    const tone = toneForState(context.state);
    const showRebook =
      context.state === "bumped" ||
      context.state === "cancelled_pre_payment" ||
      context.state === "cancelled_post_payment" ||
      context.state === "declined";
    return (
      <NarrativeCard narrative={context.narrative} tone={tone}>
        {showRebook ? (
          <Link href="/booking-requests">
            <Button variant="outline">Book these dates again</Button>
          </Link>
        ) : null}
      </NarrativeCard>
    );
  }

  const payable = context.payable;

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Complete Your Payment</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border bg-slate-50 p-3 text-sm text-slate-700">
          <p>
            Dates: {formatNZDate(new Date(payable.checkIn))} to{" "}
            {formatNZDate(new Date(payable.checkOut))}
          </p>
          <p className="mt-1">Guests: {payable.guestCount}</p>
          <p className="mt-1 font-semibold text-slate-900">
            Amount due: {formatCents(payable.amountCents)}
          </p>
          <p className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            This payment link expires on {formatNZDate(new Date(payable.expiresAt))}.
          </p>
        </div>

        {clientSecret ? (
          <StripeProvider clientSecret={clientSecret}>
            <PaymentForm
              amountCents={payable.amountCents}
              returnUrl={typeof window !== "undefined" ? window.location.href : ""}
              onSuccess={() => setPaymentComplete(true)}
              onError={() => undefined}
            />
          </StripeProvider>
        ) : (
          <div className="space-y-3">
            <Button onClick={startCardPayment} disabled={intentLoading}>
              {intentLoading ? "Preparing..." : "Pay by card"}
            </Button>
            {intentError ? (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {intentError}
              </div>
            ) : null}

            {payable.internetBankingReference ? (
              <div className="rounded-md border border-slate-200 p-3 text-sm">
                <p className="font-medium text-slate-900">Or pay by internet banking</p>
                <p className="mt-1 text-muted-foreground">
                  {(
                    bookingMessages["paymentLink.internetBanking.description"] ??
                    "Use reference {{paymentReference}} when making a direct transfer. The booking will be confirmed after the Xero invoice payment is reconciled."
                  ).replaceAll("{{paymentReference}}", payable.internetBankingReference)}
                </p>
                <p className="mt-2 font-mono text-slate-900">{payable.internetBankingReference}</p>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
