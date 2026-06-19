import Link from "next/link";
import { Button } from "@/components/ui/button";
import { InductionSettingsPanel } from "@/components/admin/induction-settings-panel";
import { InductionTemplateManager } from "@/components/admin/induction-template-manager";

export default function AdminInductionSettingsPage() {
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Induction Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Configure the nomination eligibility gate and manage the induction
            checklist template.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/admin/induction">Induction register</Link>
        </Button>
      </div>

      <InductionSettingsPanel />
      <InductionTemplateManager />
    </div>
  );
}
