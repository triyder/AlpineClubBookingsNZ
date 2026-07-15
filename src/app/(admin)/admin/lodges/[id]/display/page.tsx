import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LodgeDisplaySettingsCard } from "../_components/lodge-display-settings-card";

// Per-lodge lobby-display settings as a Configure sub-page (#110), matching the
// Rooms & Beds / Lockers pattern rather than sitting inline on the lodge hub.
// The card (LodgeDisplaySettingsCard) is unchanged — it fetches + saves against
// the admin display lodge-config API for this lodge.
export default async function LodgeDisplaySettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm">
        <Link href={`/admin/lodges/${encodeURIComponent(id)}`}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Back to lodge
        </Link>
      </Button>
      <LodgeDisplaySettingsCard lodgeId={id} />
    </div>
  );
}
