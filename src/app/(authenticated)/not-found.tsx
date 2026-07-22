import Link from "next/link";

export default function AuthenticatedNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <p className="text-5xl font-bold text-brand-charcoal">404</p>
      <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">
        We couldn&apos;t find that page
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The page or booking you&apos;re looking for doesn&apos;t exist, or you no
        longer have access to it.
      </p>
      <div className="mt-8 flex flex-col gap-3 sm:flex-row">
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center rounded-lg bg-brand-charcoal px-6 py-3 text-sm font-medium text-brand-snow transition-colors hover:bg-brand-deep"
        >
          Back to dashboard
        </Link>
        <Link
          href="/bookings"
          className="inline-flex items-center justify-center rounded-lg border border-brand-ridge/40 px-6 py-3 text-sm font-medium text-brand-charcoal transition-colors hover:bg-brand-mist"
        >
          My bookings
        </Link>
      </div>
    </div>
  );
}
