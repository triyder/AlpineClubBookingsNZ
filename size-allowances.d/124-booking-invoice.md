# Function-length allowances for fork #115, PR #124 (booking invoice)

Judged against upstream main at the 17 Nov 2026 fork sync. Each page component
was over 300 lines before the change; the invoice logic lives in its own
modules (`booking-invoice-*.ts`, `nz-bank-account.ts`).

function: src/app/(admin)/admin/lodges/page.tsx#AdminLodgesPage
lines: 373
reason: the lodge form's optional invoice details (postal address, bank account
  in four parts, GST number) and the bank-number check before save, inside the
  one form state and submit handler the page keeps for every lodge field.

function: src/app/(authenticated)/bookings/[id]/page.tsx#BookingDetailPage
lines: 363
reason: the Download invoice access check, read once with the booking the page
  already loads.
