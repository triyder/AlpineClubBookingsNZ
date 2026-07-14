import Link from "next/link";

export default function FinanceNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-20 text-center">
      <p className="text-5xl font-bold text-brand-charcoal">404</p>
      <h1 className="mt-4 text-2xl font-semibold text-brand-charcoal">
        We couldn&apos;t find that page
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        The finance page or record you&apos;re looking for doesn&apos;t exist or
        may have been removed.
      </p>
      <div className="mt-8">
        <Link
          href="/finance"
          className="inline-flex items-center justify-center rounded-lg bg-brand-charcoal px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-brand-deep"
        >
          Back to finance dashboard
        </Link>
      </div>
    </div>
  );
}
