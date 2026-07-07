import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { SetupPageClient } from "./setup-page-client";
import { loadAdminSetupPermissionMatrix } from "./permission-matrix";

// Thin server wrapper. The Setup page (support area) embeds cross-area cards —
// currently LodgeCapacityCard (lodge) plus drill-down links into finance,
// membership, bookings, and content — whose backing routes enforce different
// areas than this route. The matrix is computed server-side because
// definition-backed roles live in the DB and cannot be resolved client-side
// (same reason the layout precomputes it for the sidebar).
export default async function SetupPage() {
  const [permissionMatrix, features] = await Promise.all([
    loadAdminSetupPermissionMatrix(),
    loadEffectiveModuleFlags(),
  ]);

  return (
    <SetupPageClient
      permissionMatrix={permissionMatrix}
      features={features}
    />
  );
}
