import { SiteBannersPanel } from "@/components/admin/site-banners-panel";

export default function SiteBannersAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Site Banners</h1>
        <p className="mt-1 text-sm text-slate-500">
          Publish site-wide notices, such as emergency mountain closures, that
          display above the site header for every visitor during their display
          window. Visitors can dismiss a notice per browser; editing a banner
          shows it again.
        </p>
      </div>

      <SiteBannersPanel />
    </div>
  );
}
