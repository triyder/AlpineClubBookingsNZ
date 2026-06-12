import { PageContentPanel } from "@/components/admin/page-content-panel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function PageContentAdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Page Content</h1>
        <p className="mt-1 text-sm text-slate-500">
          Create and edit database-backed website pages, then control their menu
          display order.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Editable Pages</CardTitle>
          <CardDescription>
            Add pages, edit content, and set the menu order shown on the public
            website header.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PageContentPanel />
        </CardContent>
      </Card>
    </div>
  );
}
