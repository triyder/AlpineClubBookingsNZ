# File-size allowance for #4036 (PR #4077)

One entry, one line. The review round moved the one reading of whether a Stripe
intent is unpaid (`staleIntentAction`) out of `additional-intent-currency.ts`
into its own pure module, `stale-intent-action.ts`, so the ordinary ask's
adoption match can read it without importing the currency re-issue's database
and Stripe writers (`INV-SSOT`). This route imported it beside
`intentCurrencyDiffers` on one line; it now needs a second import line.

file: src/app/api/payments/create-payment-intent/route.ts
lines: 895
reason: one import line, for the module the unpaid reading now lives in.
  Re-exporting it from `additional-intent-currency.ts` to keep the old line
  would leave two import paths for one rule, which is what the move removes.
  Splitting an 894-line route handler is a separate job with its own review.
