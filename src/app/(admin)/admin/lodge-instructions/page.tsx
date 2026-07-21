import { LodgeInstructionsPanel } from "@/components/admin/lodge-instructions-panel";
import { CLUB_HUT_LEADER_LABEL } from "@/config/club-identity";

export default function LodgeInstructionsAdminPage() {
  const hutLeaderLower = CLUB_HUT_LEADER_LABEL.toLowerCase();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Lodge Instructions</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Maintain the opening, closing, and day-to-day instructions{" "}
          {hutLeaderLower}s rely on. These documents are protected content: they
          are only visible to admins and assigned {hutLeaderLower}s, never on the
          public website.
        </p>
      </div>

      <LodgeInstructionsPanel />
    </div>
  );
}
