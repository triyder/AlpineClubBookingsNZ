import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import type { FeatureFlags } from "@/config/schema";
import {
  canViewAdminHrefWithMatrix,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";

export interface AdminHubSection {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

function getVisibleAdminHubSections(
  sections: AdminHubSection[],
  features: FeatureFlags,
  permissionMatrix?: AdminPermissionMatrix,
) {
  return sections.filter(
    (section) =>
      isFeatureHrefVisible(section.href, features) &&
      (!permissionMatrix ||
        canViewAdminHrefWithMatrix(permissionMatrix, section.href)),
  );
}

export function AdminHubPage({
  title,
  description,
  sections,
  features,
  permissionMatrix,
}: {
  title: string;
  description: string;
  sections: AdminHubSection[];
  features: FeatureFlags;
  permissionMatrix?: AdminPermissionMatrix;
}) {
  const visibleSections = getVisibleAdminHubSections(
    sections,
    features,
    permissionMatrix,
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        <p className="mt-1 text-sm text-slate-500">{description}</p>
      </div>

      {visibleSections.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleSections.map(({ href, title, description, icon: Icon }) => (
            <Link key={href} href={href} className="group block">
              <Card className="h-full transition-colors hover:border-brand-gold/70">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5 shrink-0 text-brand-charcoal" />
                    <CardTitle>{title}</CardTitle>
                  </div>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-md border bg-slate-50 px-4 py-3 text-sm text-slate-600">
          No setup pages are available for your current permissions.
        </div>
      )}
    </div>
  );
}
