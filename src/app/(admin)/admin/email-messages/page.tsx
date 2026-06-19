import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { EmailMessageSettingsPanel } from "@/components/admin/email-settings/email-message-settings-panel";

export default function EmailMessagesPage() {
  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/admin/notifications"
          className="text-sm font-medium text-brand-charcoal underline decoration-brand-gold/70 decoration-2 underline-offset-4"
        >
          ← Notifications &amp; Email
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-slate-900">
          Email Messages
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Edit shared email variables and message wording for audited templates.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <EmailMessageSettingsPanel />
        </CardContent>
      </Card>
    </div>
  );
}
