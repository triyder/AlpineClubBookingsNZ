import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { InternetBankingSettingsPanel } from "@/components/admin/internet-banking/internet-banking-settings-panel";

export default function InternetBankingAdminPage() {
  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/admin/xero/setup"
          className="text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          ← Finance Setup
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Internet Banking
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Configure bed holds and booking lead-time rules for Xero-invoiced
          Internet Banking payments.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <InternetBankingSettingsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
