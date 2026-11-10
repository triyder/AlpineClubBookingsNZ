import { AdminHubPage } from "@/components/admin-hub-page";
import { ADMIN_APPEARANCE_PAGES } from "@/lib/admin-appearance-pages";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

export default async function AppearanceHubPage() {
  const features = await loadEffectiveModuleFlags();

  return (
    <AdminHubPage
      title="Site Appearance & Content"
      description="Manage the public site's style, editable content, banners, images, and mountain condition widgets."
      sections={ADMIN_APPEARANCE_PAGES}
      features={features}
    />
  );
}
